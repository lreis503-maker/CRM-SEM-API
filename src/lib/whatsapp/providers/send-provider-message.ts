/**
 * Picks the account's provider and sends one text or media message.
 *
 * Two entry points, on purpose:
 *
 * - `sendProviderMessage` is the simple one used by automations, flows
 *   and the AI reply path: resolve, send once, done.
 * - `loadProviderTransport` is used by `send-message.ts`, which needs the
 *   transport without the target so it can keep its Meta phone-variant
 *   retry and the contact auto-correction that goes with it.
 */

import { decrypt } from '../encryption';
import { SendMessageError } from '../send-message-error';
import { supabaseAdmin } from '../admin-client';
import { resolveUazapiInstallation } from './account-capabilities';
import { createMetaProvider, type MetaSendFunctions } from './meta-provider';
import type {
  ProviderMessageInput,
  ProviderSendResult,
  ProviderTransport,
} from './provider-transport';
import { isRecipientNotAllowedError, phoneVariants } from '../phone-utils';
import {
  resolveProviderSendTarget,
  type ProviderSendTarget,
  type SendTargetContact,
} from './resolve-send-target';
import type { UazapiInstallation, WhatsAppProvider } from './types';
import {
  createUazapiInstanceClient,
  type UazapiInstanceClient,
} from './uazapi-client';
import { createUazapiProvider } from './uazapi-provider';

export type {
  ProviderMessageInput,
  ProviderSendResult,
  ProviderTransport,
} from './provider-transport';

export interface WhatsAppConfigRow {
  id: string;
  provider?: string | null;
  status?: string | null;
  phone_number_id?: string | null;
  access_token?: string | null;
  [key: string]: unknown;
}

export interface LoadedProviderTransport {
  provider: WhatsAppProvider;
  transport: ProviderTransport;
  /** The configuration row, for callers that still need Meta-only fields. */
  config: WhatsAppConfigRow;
  /** Decrypted Meta access token, or null on a UAZAPI account. */
  accessToken: string | null;
}

export interface ProviderTransportDeps {
  installation?: UazapiInstallation | null;
  loadInstanceToken?: (configId: string) => Promise<string | null>;
  createUazapiClient?: (input: {
    baseUrl: string;
    instanceToken: string;
  }) => UazapiInstanceClient;
  metaFns?: MetaSendFunctions;
}

interface ConfigReader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

/**
 * Reads the encrypted instance token with the service role, because
 * `whatsapp_config_secrets` is deliberately unreachable from a session.
 */
async function loadInstanceTokenFromSecrets(
  configId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config_secrets')
    .select('uazapi_instance_token')
    .eq('whatsapp_config_id', configId)
    .maybeSingle();

  if (error) throw error;

  const ciphertext = (data as { uazapi_instance_token?: string } | null)
    ?.uazapi_instance_token;
  return typeof ciphertext === 'string' && ciphertext.length > 0
    ? decrypt(ciphertext)
    : null;
}

export async function loadProviderTransport(
  db: ConfigReader,
  accountId: string,
  deps: ProviderTransportDeps = {}
): Promise<LoadedProviderTransport> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (error || !data) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'O WhatsApp não está configurado. Configure a integração com o WhatsApp primeiro.',
      400
    );
  }

  const config = data as WhatsAppConfigRow;
  const provider: WhatsAppProvider =
    config.provider === 'uazapi' ? 'uazapi' : 'meta';

  if (provider === 'meta') {
    // Meta rows can legitimately sit in 'disconnected' with working
    // credentials — a save whose /register step failed does exactly that,
    // and those accounts have always been able to send. Nothing here
    // narrows that.
    const accessToken = decrypt(String(config.access_token ?? ''));
    return {
      provider,
      config,
      accessToken,
      transport: createMetaProvider({
        phoneNumberId: String(config.phone_number_id ?? ''),
        accessToken,
        fns: deps.metaFns,
      }),
    };
  }

  // UAZAPI has no credential that works while the session is down: an
  // unpaired instance simply has no WhatsApp to send through.
  if (config.status !== 'connected') {
    throw new SendMessageError(
      'whatsapp_not_connected',
      'A conexão do WhatsApp não está ativa. Abra Configurações e leia o QR Code novamente.',
      409
    );
  }

  const installation =
    deps.installation === undefined
      ? resolveUazapiInstallation(process.env)
      : deps.installation;

  if (!installation) {
    throw new SendMessageError(
      'uazapi_not_available',
      'A UAZAPI não está habilitada nesta instalação.',
      503
    );
  }

  const loadToken = deps.loadInstanceToken ?? loadInstanceTokenFromSecrets;
  const instanceToken = await loadToken(config.id);
  if (instanceToken === null) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'A conexão UAZAPI está incompleta. Abra Configurações e conecte novamente.',
      400
    );
  }

  const createClient = deps.createUazapiClient ?? createUazapiInstanceClient;

  return {
    provider,
    config,
    accessToken: null,
    transport: createUazapiProvider(
      createClient({ baseUrl: installation.baseUrl, instanceToken })
    ),
  };
}

/**
 * Runs `attempt` against the resolved target, walking Meta's phone
 * variants when the first form is rejected as "recipient not in allowed
 * list", and writing the working number back to the contact.
 *
 * Meta sandbox numbers and numbers registered with or without a trunk 0
 * both need this to land reliably, so every Meta send path shares it.
 * UAZAPI deliberately gets exactly one attempt: a second one could
 * deliver the same message to a real person twice.
 */
export async function attemptAcrossPhoneVariants<T>(input: {
  db: ConfigReader;
  contactId: string;
  provider: WhatsAppProvider;
  target: ProviderSendTarget;
  attempt: (target: string) => Promise<T>;
}): Promise<T> {
  const { db, contactId, provider, target, attempt } = input;

  const variants =
    provider === 'meta' && target.isPhone
      ? phoneVariants(target.target)
      : [target.target];

  let lastError: unknown = null;
  for (const variant of variants) {
    try {
      const result = await attempt(variant);
      if (target.isPhone && variant !== target.target) {
        await db
          .from('contacts')
          .update({ phone: variant })
          .eq('id', contactId);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRecipientNotAllowedError(message)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

/**
 * Sends one message to a contact through whichever provider the account
 * has active, keeping Meta's phone-variant retry.
 */
export async function sendProviderMessage(
  db: ConfigReader,
  accountId: string,
  contact: SendTargetContact | null | undefined,
  message: ProviderMessageInput,
  deps: ProviderTransportDeps = {}
): Promise<ProviderSendResult> {
  const loaded = await loadProviderTransport(db, accountId, deps);
  const target = await resolveProviderSendTarget(
    db,
    accountId,
    loaded.provider,
    contact
  );

  return attemptAcrossPhoneVariants({
    db,
    contactId: contact?.id ?? '',
    provider: loaded.provider,
    target,
    attempt: (resolved) => loaded.transport.send(resolved, message),
  });
}
