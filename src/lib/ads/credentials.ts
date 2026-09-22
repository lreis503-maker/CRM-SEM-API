/**
 * Leitura e gravação do token de usuário de sistema do Business
 * Manager.
 *
 * O token fica cifrado em `ad_platform_credential_secrets`, tabela sem
 * policy nenhuma: nem uma falha futura de RLS em outro lugar abre um
 * caminho do navegador até ele. Todo acesso passa por aqui, com o
 * cliente service role, e o texto claro nunca sai desta camada em
 * direção a uma resposta HTTP.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

export type AdPlatform = 'meta';

export interface AdPlatformCredential {
  id: string;
  accountId: string;
  platform: AdPlatform;
  label: string | null;
  businessId: string | null;
  internalNotifyPhone: string | null;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
}

export interface AdPlatformCredentialWithToken extends AdPlatformCredential {
  /** Texto claro. Não devolver numa resposta nem gravar em log. */
  accessToken: string;
}

function mapRow(row: Record<string, unknown>): AdPlatformCredential {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    platform: 'meta',
    label: typeof row.label === 'string' ? row.label : null,
    businessId: typeof row.business_id === 'string' ? row.business_id : null,
    internalNotifyPhone:
      typeof row.internal_notify_phone === 'string'
        ? row.internal_notify_phone
        : null,
    lastVerifiedAt:
      typeof row.last_verified_at === 'string' ? row.last_verified_at : null,
    lastVerifyError:
      typeof row.last_verify_error === 'string' ? row.last_verify_error : null,
  };
}

/** Metadados da credencial. Seguro para devolver ao navegador. */
export async function loadAdPlatformCredential(
  db: SupabaseClient,
  accountId: string,
  platform: AdPlatform = 'meta'
): Promise<AdPlatformCredential | null> {
  const { data, error } = await db
    .from('ad_platform_credentials')
    .select(
      'id, account_id, label, business_id, internal_notify_phone, last_verified_at, last_verify_error'
    )
    .eq('account_id', accountId)
    .eq('platform', platform)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return mapRow(data as Record<string, unknown>);
}

/**
 * A mesma credencial, já com o token decifrado.
 *
 * Devolve `null` quando existe a linha de metadados mas não existe o
 * segredo — estado possível se alguém apagar a linha de segredo à mão.
 * Tratar como "não configurado" é mais seguro do que estourar no meio
 * de um ciclo de verificação.
 */
export async function loadAdPlatformCredentialWithToken(
  db: SupabaseClient,
  accountId: string,
  platform: AdPlatform = 'meta'
): Promise<AdPlatformCredentialWithToken | null> {
  const credential = await loadAdPlatformCredential(db, accountId, platform);
  if (credential === null) return null;

  const { data, error } = await db
    .from('ad_platform_credential_secrets')
    .select('access_token')
    .eq('credential_id', credential.id)
    .maybeSingle();

  if (error) throw error;

  const ciphertext = (data as { access_token?: unknown } | null)?.access_token;
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null;

  return { ...credential, accessToken: decrypt(ciphertext) };
}

export interface SaveAdPlatformCredentialInput {
  accountId: string;
  platform?: AdPlatform;
  /** Texto claro; é cifrado aqui dentro. Omitir mantém o token atual. */
  accessToken?: string;
  label?: string | null;
  businessId?: string | null;
  internalNotifyPhone?: string | null;
}

/**
 * Cria ou atualiza a credencial.
 *
 * Duas escritas em vez de uma transação: o Supabase não expõe
 * transação pelo PostgREST, e a ordem escolhida — metadados primeiro,
 * segredo depois — faz o pior caso ser "existe credencial sem token",
 * que `loadAdPlatformCredentialWithToken` já lê como não configurada.
 * A ordem inversa deixaria um token órfão no banco.
 */
export async function saveAdPlatformCredential(
  db: SupabaseClient,
  input: SaveAdPlatformCredentialInput
): Promise<AdPlatformCredential> {
  const platform = input.platform ?? 'meta';

  const patch: Record<string, unknown> = {
    account_id: input.accountId,
    platform,
    updated_at: new Date().toISOString(),
  };
  if (input.label !== undefined) patch.label = input.label;
  if (input.businessId !== undefined) patch.business_id = input.businessId;
  if (input.internalNotifyPhone !== undefined) {
    patch.internal_notify_phone = input.internalNotifyPhone;
  }

  const { data, error } = await db
    .from('ad_platform_credentials')
    .upsert(patch, { onConflict: 'account_id,platform' })
    .select(
      'id, account_id, label, business_id, internal_notify_phone, last_verified_at, last_verify_error'
    )
    .single();

  if (error) throw error;
  const credential = mapRow(data as Record<string, unknown>);

  if (input.accessToken !== undefined && input.accessToken.length > 0) {
    const { error: secretError } = await db
      .from('ad_platform_credential_secrets')
      .upsert(
        {
          credential_id: credential.id,
          access_token: encrypt(input.accessToken),
        },
        { onConflict: 'credential_id' }
      );
    if (secretError) throw secretError;
  }

  return credential;
}

/** Marca o resultado da última validação. Nunca toca no token. */
export async function recordCredentialVerification(
  db: SupabaseClient,
  credentialId: string,
  result: { ok: boolean; error?: string | null }
): Promise<void> {
  await db
    .from('ad_platform_credentials')
    .update({
      last_verified_at: new Date().toISOString(),
      last_verify_error: result.ok ? null : (result.error ?? 'erro desconhecido'),
      updated_at: new Date().toISOString(),
    })
    .eq('id', credentialId);
}
