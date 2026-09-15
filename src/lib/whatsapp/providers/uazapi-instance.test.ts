import { beforeEach, describe, expect, it, vi } from 'vitest';

import { decrypt } from '../encryption';
import { UazapiClientError } from './uazapi-errors';
import {
  beginUazapiConnection,
  disconnectUazapiInstance,
  hashUazapiWebhookSecret,
  refreshUazapiConnection,
  regenerateUazapiQrCode,
  removeUazapiConnection,
} from './uazapi-instance';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const QR_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const PLAIN_TOKEN = 'plain-instance-token';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

function connectingInstance(overrides = {}) {
  return {
    id: 'i-1',
    name: 'wacrm-acc1-a1b2',
    status: 'connecting' as const,
    connected: false,
    loggedIn: false,
    qrCodeDataUrl: QR_DATA_URL,
    ownerPhone: null,
    profileName: null,
    profilePicUrl: null,
    lastDisconnectReason: null,
    ...overrides,
  };
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const instance = {
    configureWebhook: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(connectingInstance()),
    getStatus: vi.fn().mockResolvedValue(connectingInstance()),
    disconnect: vi.fn().mockResolvedValue(undefined),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn(),
    sendMedia: vi.fn(),
    downloadMessage: vi.fn(),
  };

  const admin = {
    createInstance: vi.fn().mockResolvedValue({
      instance: connectingInstance({ status: 'disconnected' }),
      token: PLAIN_TOKEN,
    }),
  };

  const ctx: Record<string, unknown> = {
    accountId: 'acc-10000000-0000-4000-8000-000000000001',
    userId: 'user-1',
    siteUrl: 'https://crm.example.com',
    admin,
    instance,
    instanceClientFor: vi.fn(() => instance),
    loadConfig: vi.fn().mockResolvedValue(null),
    loadInstanceToken: vi.fn().mockResolvedValue(null),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    deleteConfig: vi.fn().mockResolvedValue(undefined),
    savedConfig: null as Record<string, string> | null,
    now: () => NOW,
    generateWebhookSecret: () => 'plain-webhook-secret',
    generateAttemptId: () => ATTEMPT_ID,
    generateInstanceSuffix: () => 'a1b2',
  };

  ctx.replaceConfig = vi.fn(async (input: Record<string, string>) => {
    ctx.savedConfig = input;
    return {
      configId: 'cfg-1',
      cancelledBroadcasts: 2,
      deactivatedAutomations: 1,
      draftedFlows: 0,
      stoppedFlowRuns: 0,
    };
  });

  return Object.assign(ctx, overrides) as never;
}

function uazapiConfig(overrides = {}) {
  return {
    id: 'cfg-1',
    provider: 'uazapi',
    status: 'connecting',
    uazapi_instance_id: 'i-1',
    uazapi_instance_name: 'wacrm-acc1-a1b2',
    uazapi_webhook_secret_hash: 'f'.repeat(64),
    connection_attempt_id: ATTEMPT_ID,
    connected_phone: null,
    connected_name: null,
    connected_avatar_url: null,
    last_connection_error: null,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ports(ctx: never): any {
  return ctx as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

describe('beginUazapiConnection', () => {
  it('stores only the webhook hash and encrypted instance token', async () => {
    const ctx = makeContext();

    const result = await beginUazapiConnection(ctx);

    expect(result.publicView).not.toHaveProperty('instanceToken');
    expect(JSON.stringify(result.publicView)).not.toContain(PLAIN_TOKEN);
    expect(JSON.stringify(result.publicView)).not.toContain(
      'plain-webhook-secret'
    );

    const saved = ports(ctx).savedConfig as unknown as Record<string, string>;
    expect(saved.uazapi_webhook_secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.uazapi_webhook_secret_hash).toBe(
      hashUazapiWebhookSecret('plain-webhook-secret')
    );
    expect(saved.uazapi_instance_token).not.toBe(PLAIN_TOKEN);
    expect(decrypt(saved.uazapi_instance_token)).toBe(PLAIN_TOKEN);
  });

  it('subscribes the webhook to exactly the agreed events and filters', async () => {
    const ctx = makeContext();

    await beginUazapiConnection(ctx);

    expect(ports(ctx).instance.configureWebhook).toHaveBeenCalledWith({
      enabled: true,
      url: 'https://crm.example.com/api/whatsapp/webhook/uazapi/plain-webhook-secret',
      events: ['messages', 'messages_update', 'connection'],
      excludeMessages: ['wasSentByApi', 'fromMeYes', 'isGroupYes'],
      addUrlEvents: false,
      addUrlTypesMessages: false,
    });
  });

  it('names the instance from the account id without any personal data', async () => {
    const ctx = makeContext();

    await beginUazapiConnection(ctx);

    const name = ports(ctx).admin.createInstance.mock.calls[0][0]
      .name as string;
    expect(name).toBe('wacrm-acc10000-a1b2');
    expect(name).not.toContain('@');
    expect(ports(ctx).savedConfig.uazapi_instance_name).toBe(name);
  });

  it('deletes the remote instance when webhook setup fails', async () => {
    const ctx = makeContext();
    ports(ctx).instance.configureWebhook.mockRejectedValue(
      new Error('upstream')
    );

    await expect(beginUazapiConnection(ctx)).rejects.toThrow();

    expect(ports(ctx).instance.deleteInstance).toHaveBeenCalledOnce();
    expect(ports(ctx).replaceConfig).not.toHaveBeenCalled();
  });

  it('deletes the remote instance when the switch transaction fails', async () => {
    const ctx = makeContext();
    ports(ctx).replaceConfig.mockRejectedValue(new Error('deadlock'));

    await expect(beginUazapiConnection(ctx)).rejects.toThrow();

    expect(ports(ctx).instance.deleteInstance).toHaveBeenCalledOnce();
    expect(ports(ctx).deleteConfig).not.toHaveBeenCalled();
  });

  it('returns the QR, its expiry and the cancelled work', async () => {
    const ctx = makeContext();

    const result = await beginUazapiConnection(ctx);

    expect(result.publicView).toEqual({
      provider: 'uazapi',
      status: 'connecting',
      attemptId: ATTEMPT_ID,
      qrCodeDataUrl: QR_DATA_URL,
      qrExpiresAt: '2026-09-15T12:02:00.000Z',
      connectedPhone: null,
      connectedName: null,
      connectedAvatarUrl: null,
      error: null,
    });
    expect(result.affected).toEqual({
      cancelledBroadcasts: 2,
      deactivatedAutomations: 1,
      draftedFlows: 0,
      stoppedFlowRuns: 0,
    });
  });

  it('keeps a recoverable row when the QR call fails after the switch', async () => {
    const ctx = makeContext();
    ports(ctx).instance.connect.mockRejectedValue(
      new UazapiClientError({
        operation: 'instance.connect',
        kind: 'upstream_unavailable',
        httpStatus: 503,
        idempotent: true,
      })
    );

    const result = await beginUazapiConnection(ctx);

    expect(result.publicView.status).toBe('error');
    expect(result.publicView.qrCodeDataUrl).toBeNull();
    expect(result.publicView.error).toBe('upstream_unavailable');
    expect(ports(ctx).instance.deleteInstance).not.toHaveBeenCalled();
    expect(ports(ctx).updateConfig).toHaveBeenCalledWith(
      'cfg-1',
      expect.objectContaining({
        status: 'error',
        last_connection_error: 'upstream_unavailable',
      })
    );
  });

  it('resumes the existing instance instead of creating a second one', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);

    const result = await beginUazapiConnection(ctx);

    expect(ports(ctx).admin.createInstance).not.toHaveBeenCalled();
    expect(ports(ctx).replaceConfig).not.toHaveBeenCalled();
    expect(ports(ctx).instance.connect).toHaveBeenCalledOnce();
    expect(result.affected).toBeNull();
    expect(result.publicView.qrCodeDataUrl).toBe(QR_DATA_URL);
  });

  it('creates a fresh instance when the account is still on Meta', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue({
      id: 'cfg-meta',
      provider: 'meta',
      status: 'connected',
    });

    await beginUazapiConnection(ctx);

    expect(ports(ctx).admin.createInstance).toHaveBeenCalledOnce();
    expect(ports(ctx).replaceConfig).toHaveBeenCalledOnce();
  });
});

describe('refreshUazapiConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the connected identity and stops offering a QR', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);
    ports(ctx).instance.getStatus.mockResolvedValue(
      connectingInstance({
        status: 'connected',
        connected: true,
        loggedIn: true,
        qrCodeDataUrl: null,
        ownerPhone: '5511999999999',
        profileName: 'Loja ABC',
        profilePicUrl: 'https://cdn.example.com/p.jpg',
      })
    );

    const view = await refreshUazapiConnection(ctx, { attemptId: ATTEMPT_ID });

    expect(view).toMatchObject({
      status: 'connected',
      qrCodeDataUrl: null,
      connectedPhone: '5511999999999',
      connectedName: 'Loja ABC',
      connectedAvatarUrl: 'https://cdn.example.com/p.jpg',
    });
    expect(ports(ctx).updateConfig).toHaveBeenCalledWith(
      'cfg-1',
      expect.objectContaining({
        status: 'connected',
        connected_phone: '5511999999999',
        connected_name: 'Loja ABC',
        connected_avatar_url: 'https://cdn.example.com/p.jpg',
        last_connection_error: null,
        connection_checked_at: NOW.toISOString(),
      })
    );
  });

  it('never persists the QR code', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);

    await refreshUazapiConnection(ctx, {});

    const patch = ports(ctx).updateConfig.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(patch)).not.toContain('base64');
  });

  it('ignores a stale attempt without asking UAZAPI again', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);

    const view = await refreshUazapiConnection(ctx, {
      attemptId: '22222222-2222-4222-8222-222222222222',
    });

    expect(ports(ctx).instance.getStatus).not.toHaveBeenCalled();
    expect(ports(ctx).updateConfig).not.toHaveBeenCalled();
    expect(view.attemptId).toBe(ATTEMPT_ID);
  });

  it('maps a hibernated session to its own state', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);
    ports(ctx).instance.getStatus.mockResolvedValue(
      connectingInstance({ status: 'hibernated', qrCodeDataUrl: null })
    );

    const view = await refreshUazapiConnection(ctx, {});

    expect(view.status).toBe('hibernated');
  });

  it('refuses to read a Meta account through the UAZAPI path', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue({
      id: 'cfg-meta',
      provider: 'meta',
      status: 'connected',
    });

    await expect(refreshUazapiConnection(ctx, {})).rejects.toMatchObject({
      code: 'wrong_provider',
      status: 409,
    });
  });

  it('records an upstream failure without losing the instance', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);
    ports(ctx).instance.getStatus.mockRejectedValue(
      new UazapiClientError({
        operation: 'instance.status',
        kind: 'authentication',
        httpStatus: 401,
        idempotent: true,
      })
    );

    const view = await refreshUazapiConnection(ctx, {});

    expect(view.status).toBe('error');
    expect(view.error).toBe('authentication');
    expect(ports(ctx).deleteConfig).not.toHaveBeenCalled();
  });
});

describe('regenerateUazapiQrCode', () => {
  it('reuses the instance and rotates the connection attempt', async () => {
    const ctx = makeContext({
      generateAttemptId: () => '33333333-3333-4333-8333-333333333333',
    });
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);

    const view = await regenerateUazapiQrCode(ctx);

    expect(ports(ctx).admin.createInstance).not.toHaveBeenCalled();
    expect(ports(ctx).instance.connect).toHaveBeenCalledOnce();
    expect(view.attemptId).toBe('33333333-3333-4333-8333-333333333333');
    expect(view.qrCodeDataUrl).toBe(QR_DATA_URL);
    expect(ports(ctx).updateConfig).toHaveBeenCalledWith(
      'cfg-1',
      expect.objectContaining({
        status: 'connecting',
        connection_attempt_id: '33333333-3333-4333-8333-333333333333',
      })
    );
  });
});

describe('disconnectUazapiInstance', () => {
  it('ends the session but keeps the instance for a failed Meta switch', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);

    await disconnectUazapiInstance(ctx);

    expect(ports(ctx).instance.disconnect).toHaveBeenCalledOnce();
    expect(ports(ctx).instance.deleteInstance).not.toHaveBeenCalled();
    expect(ports(ctx).deleteConfig).not.toHaveBeenCalled();
    expect(ports(ctx).updateConfig).toHaveBeenCalledWith(
      'cfg-1',
      expect.objectContaining({ status: 'disconnected' })
    );
  });

  it('still records the disconnected state when the instance is gone', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);
    ports(ctx).instance.disconnect.mockRejectedValue(
      new UazapiClientError({
        operation: 'instance.disconnect',
        kind: 'not_found',
        httpStatus: 404,
        idempotent: true,
      })
    );

    await expect(disconnectUazapiInstance(ctx)).resolves.toBeUndefined();
    expect(ports(ctx).updateConfig).toHaveBeenCalledOnce();
  });
});

describe('regenerateUazapiQrCode re-registers the webhook', () => {
  it('points the webhook at the installation site URL in use right now', async () => {
    const ctx = makeContext({
      siteUrl: 'https://corrigido.example.com',
      generateWebhookSecret: () => 'segredo-novo',
    });
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);

    await regenerateUazapiQrCode(ctx);

    // Without this the URL stays frozen at whatever it was the first time
    // the account paired, so fixing a wrong site URL never takes effect.
    expect(ports(ctx).instance.configureWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://corrigido.example.com/api/whatsapp/webhook/uazapi/segredo-novo',
      })
    );
  });

  it('rotates the route secret and stores only the new hash', async () => {
    const ctx = makeContext({ generateWebhookSecret: () => 'segredo-novo' });
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);

    await regenerateUazapiQrCode(ctx);

    const patch = ports(ctx).updateConfig.mock.calls[0][1];
    expect(patch.uazapi_webhook_secret_hash).toBe(
      hashUazapiWebhookSecret('segredo-novo')
    );
    expect(JSON.stringify(patch)).not.toContain('segredo-novo');
  });

  it('re-registers when a pairing is resumed, not only on a fresh one', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);

    await beginUazapiConnection(ctx);

    expect(ports(ctx).admin.createInstance).not.toHaveBeenCalled();
    expect(ports(ctx).instance.configureWebhook).toHaveBeenCalledOnce();
  });

  it('does not touch the stored hash when the provider refuses the webhook', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);
    ports(ctx).instance.configureWebhook.mockRejectedValue(
      new Error('upstream')
    );

    await expect(regenerateUazapiQrCode(ctx)).rejects.toThrow();
    expect(ports(ctx).updateConfig).not.toHaveBeenCalled();
    expect(ports(ctx).instance.connect).not.toHaveBeenCalled();
  });
});

describe('removeUazapiConnection', () => {
  it('removes the local row only after the remote instance is gone', async () => {
    const order: string[] = [];
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);
    ports(ctx).instance.disconnect.mockImplementation(async () => {
      order.push('disconnect');
    });
    ports(ctx).instance.deleteInstance.mockImplementation(async () => {
      order.push('deleteInstance');
    });
    ports(ctx).deleteConfig.mockImplementation(async () => {
      order.push('deleteConfig');
    });

    await removeUazapiConnection(ctx);

    expect(order).toEqual(['disconnect', 'deleteInstance', 'deleteConfig']);
  });

  it('treats an already absent instance as removed', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);
    const missing = new UazapiClientError({
      operation: 'instance.delete',
      kind: 'not_found',
      httpStatus: 404,
      idempotent: true,
    });
    ports(ctx).instance.disconnect.mockRejectedValue(missing);
    ports(ctx).instance.deleteInstance.mockRejectedValue(missing);

    await expect(removeUazapiConnection(ctx)).resolves.toBeUndefined();
    expect(ports(ctx).deleteConfig).toHaveBeenCalledWith('cfg-1');
  });

  it('keeps the row when the remote delete fails for another reason', async () => {
    const ctx = makeContext();
    ports(ctx).loadConfig.mockResolvedValue(uazapiConfig());
    ports(ctx).loadInstanceToken.mockResolvedValue(PLAIN_TOKEN);
    ports(ctx).instance.deleteInstance.mockRejectedValue(
      new UazapiClientError({
        operation: 'instance.delete',
        kind: 'upstream_unavailable',
        httpStatus: 503,
        idempotent: true,
      })
    );

    await expect(removeUazapiConnection(ctx)).rejects.toThrow();
    expect(ports(ctx).deleteConfig).not.toHaveBeenCalled();
  });
});
