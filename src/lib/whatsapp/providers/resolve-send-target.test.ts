import { describe, expect, it, vi } from 'vitest';

import { resolveProviderSendTarget } from './resolve-send-target';

interface Filter {
  column: string;
  value: unknown;
}

function identitiesDb(rows: Array<Record<string, unknown>>) {
  const filters: Filter[] = [];
  const tables: string[] = [];

  const db = {
    from(table: string) {
      tables.push(table);
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters.push({ column, value });
          return query;
        },
        then: (resolve: (r: { data: unknown; error: unknown }) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return query;
    },
  };

  return { db, filters, tables };
}

const PHONE_CONTACT = { id: 'c-1', phone: '+55 11 99999-9999' };
const USERNAME_CONTACT = {
  id: 'c-2',
  phone: null,
  wa_user_id: 'US.13491208655302741918',
};

describe('resolveProviderSendTarget for Meta', () => {
  it('keeps the existing phone resolution', async () => {
    const { db, tables } = identitiesDb([]);

    await expect(
      resolveProviderSendTarget(db, 'acc-1', 'meta', PHONE_CONTACT)
    ).resolves.toEqual({
      provider: 'meta',
      target: '5511999999999',
      isPhone: true,
    });
    expect(tables).toEqual([]);
  });

  it('keeps addressing a username-only contact by business-scoped id', async () => {
    const { db } = identitiesDb([]);

    await expect(
      resolveProviderSendTarget(db, 'acc-1', 'meta', USERNAME_CONTACT)
    ).resolves.toEqual({
      provider: 'meta',
      target: 'US.13491208655302741918',
      isPhone: false,
    });
  });

  it('never looks at a UAZAPI identity for a Meta send', async () => {
    const { db, tables } = identitiesDb([
      { external_id: '123@lid', kind: 'lid' },
    ]);

    await expect(
      resolveProviderSendTarget(db, 'acc-1', 'meta', { id: 'c-3', phone: null })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(tables).toEqual([]);
  });
});

describe('resolveProviderSendTarget for UAZAPI', () => {
  it('prefers the contact phone and never queries identities', async () => {
    const { db, tables } = identitiesDb([]);

    await expect(
      resolveProviderSendTarget(db, 'acc-1', 'uazapi', PHONE_CONTACT)
    ).resolves.toEqual({
      provider: 'uazapi',
      target: '5511999999999',
      isPhone: true,
    });
    expect(tables).toEqual([]);
  });

  it('falls back to the stored LID when there is no phone', async () => {
    const { db, filters, tables } = identitiesDb([
      { external_id: '5511999999999@s.whatsapp.net', kind: 'jid' },
      { external_id: '182736@lid', kind: 'lid' },
    ]);

    await expect(
      resolveProviderSendTarget(db, 'acc-1', 'uazapi', {
        id: 'c-9',
        phone: null,
      })
    ).resolves.toEqual({
      provider: 'uazapi',
      target: '182736@lid',
      isPhone: false,
    });

    expect(tables).toEqual(['whatsapp_contact_identities']);
    expect(filters).toContainEqual({ column: 'account_id', value: 'acc-1' });
    expect(filters).toContainEqual({ column: 'contact_id', value: 'c-9' });
    expect(filters).toContainEqual({ column: 'provider', value: 'uazapi' });
  });

  it('uses a JID when no LID has been seen', async () => {
    const { db } = identitiesDb([
      { external_id: '5511999999999@s.whatsapp.net', kind: 'jid' },
    ]);

    await expect(
      resolveProviderSendTarget(db, 'acc-1', 'uazapi', {
        id: 'c-9',
        phone: null,
      })
    ).resolves.toMatchObject({ target: '5511999999999@s.whatsapp.net' });
  });

  it('ignores a Meta business-scoped id, which UAZAPI cannot address', async () => {
    const { db } = identitiesDb([]);

    await expect(
      resolveProviderSendTarget(db, 'acc-1', 'uazapi', USERNAME_CONTACT)
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('fails with a clear code when nothing addressable exists', async () => {
    const { db } = identitiesDb([]);

    await expect(
      resolveProviderSendTarget(db, 'acc-1', 'uazapi', {
        id: 'c-9',
        phone: null,
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('surfaces a database failure instead of silently having no target', async () => {
    const db = {
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          then: (resolve: (r: { data: unknown; error: unknown }) => unknown) =>
            resolve({ data: null, error: { message: 'boom' } }),
        };
        return query;
      },
    };

    await expect(
      resolveProviderSendTarget(db, 'acc-1', 'uazapi', {
        id: 'c-9',
        phone: null,
      })
    ).rejects.toThrow();
  });

  it('does not treat an unusable phone as addressable', async () => {
    const { db } = identitiesDb([]);
    const spy = vi.fn();

    await expect(
      resolveProviderSendTarget(db, 'acc-1', 'uazapi', {
        id: 'c-9',
        phone: '123',
      })
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(spy).not.toHaveBeenCalled();
  });
});
