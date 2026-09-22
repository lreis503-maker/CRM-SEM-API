/**
 * Os portfólios empresariais conectados e seus tokens.
 *
 * Uma conta do CRM pode ter vários portfólios, cada um com o seu
 * token de usuário de sistema — o usuário de sistema de um portfólio
 * não enxerga as contas de anúncio do outro, então não há como
 * atender dois portfólios com uma credencial só.
 *
 * O token de cada um fica cifrado em `ad_platform_credential_secrets`,
 * tabela sem policy nenhuma: nem uma falha futura de RLS em outro
 * lugar abre um caminho do navegador até ele. Todo acesso passa por
 * aqui, com o cliente service role, e o texto claro nunca sai desta
 * camada em direção a uma resposta HTTP.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

export type AdPlatform = 'meta';

const CREDENTIAL_COLUMNS =
  'id, account_id, label, business_id, internal_notify_phone, last_verified_at, last_verify_error';

export interface AdPlatformCredential {
  id: string;
  accountId: string;
  platform: AdPlatform;
  /** Nome do portfólio. Obrigatório desde a migração 048. */
  label: string;
  businessId: string | null;
  internalNotifyPhone: string | null;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
}

function mapRow(row: Record<string, unknown>): AdPlatformCredential {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    platform: 'meta',
    label: typeof row.label === 'string' ? row.label : '',
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

/** Todos os portfólios da conta. Seguro para devolver ao navegador. */
export async function listAdPlatformCredentials(
  db: SupabaseClient,
  accountId: string,
  platform: AdPlatform = 'meta'
): Promise<AdPlatformCredential[]> {
  const { data, error } = await db
    .from('ad_platform_credentials')
    .select(CREDENTIAL_COLUMNS)
    .eq('account_id', accountId)
    .eq('platform', platform)
    .order('label', { ascending: true });

  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(mapRow);
}

/**
 * Um portfólio, sempre filtrado por `account_id`.
 *
 * O filtro não é decoração: as rotas escrevem com service role, que
 * ignora RLS, e um id sozinho não prova que a credencial é de quem
 * está pedindo.
 */
export async function loadAdPlatformCredential(
  db: SupabaseClient,
  accountId: string,
  credentialId: string
): Promise<AdPlatformCredential | null> {
  const { data, error } = await db
    .from('ad_platform_credentials')
    .select(CREDENTIAL_COLUMNS)
    .eq('id', credentialId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) throw error;
  return data ? mapRow(data as Record<string, unknown>) : null;
}

/**
 * O token decifrado de um portfólio.
 *
 * Devolve `null` quando a linha de metadados existe mas o segredo não
 * — estado possível se alguém apagar a linha de segredo à mão. Tratar
 * como "não configurado" é mais seguro do que estourar no meio de um
 * ciclo de verificação.
 */
export async function loadCredentialToken(
  db: SupabaseClient,
  credentialId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('ad_platform_credential_secrets')
    .select('access_token')
    .eq('credential_id', credentialId)
    .maybeSingle();

  if (error) throw error;

  const ciphertext = (data as { access_token?: unknown } | null)?.access_token;
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null;

  return decrypt(ciphertext);
}

export interface SaveAdPlatformCredentialInput {
  accountId: string;
  platform?: AdPlatform;
  /** Ausente cria um portfólio novo; presente atualiza aquele. */
  credentialId?: string;
  label?: string;
  /** Texto claro; é cifrado aqui dentro. Omitir mantém o token atual. */
  accessToken?: string;
  businessId?: string | null;
  internalNotifyPhone?: string | null;
}

/**
 * Cria ou atualiza um portfólio.
 *
 * Duas escritas em vez de uma transação: o Supabase não expõe
 * transação pelo PostgREST, e a ordem escolhida — metadados primeiro,
 * segredo depois — faz o pior caso ser "portfólio sem token", que o
 * runner já lê como não configurado e mostra na tela. A ordem inversa
 * deixaria um token órfão no banco.
 */
export async function saveAdPlatformCredential(
  db: SupabaseClient,
  input: SaveAdPlatformCredentialInput
): Promise<AdPlatformCredential> {
  const platform = input.platform ?? 'meta';

  let credential: AdPlatformCredential;

  if (input.credentialId) {
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (input.label !== undefined) patch.label = input.label;
    if (input.businessId !== undefined) patch.business_id = input.businessId;
    if (input.internalNotifyPhone !== undefined) {
      patch.internal_notify_phone = input.internalNotifyPhone;
    }

    const { data, error } = await db
      .from('ad_platform_credentials')
      .update(patch)
      .eq('id', input.credentialId)
      .eq('account_id', input.accountId)
      .select(CREDENTIAL_COLUMNS)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Portfólio não encontrado nesta conta.');
    credential = mapRow(data as Record<string, unknown>);
  } else {
    const { data, error } = await db
      .from('ad_platform_credentials')
      .insert({
        account_id: input.accountId,
        platform,
        label: input.label,
        business_id: input.businessId ?? null,
        internal_notify_phone: input.internalNotifyPhone ?? null,
      })
      .select(CREDENTIAL_COLUMNS)
      .single();

    if (error) throw error;
    credential = mapRow(data as Record<string, unknown>);
  }

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

/**
 * Remove um portfólio.
 *
 * Recusa enquanto houver conta de anúncio ligada a ele. A checagem é
 * feita aqui para a pessoa receber uma frase em português em vez do
 * erro de chave estrangeira; o `ON DELETE RESTRICT` da migração 048
 * continua sendo a rede de segurança, caso a remoção venha por outro
 * caminho.
 */
export async function deleteAdPlatformCredential(
  db: SupabaseClient,
  accountId: string,
  credentialId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data: linked, error: linkedError } = await db
    .from('ad_account_monitors')
    .select('id')
    .eq('account_id', accountId)
    .eq('credential_id', credentialId)
    .limit(1);

  if (linkedError) throw linkedError;
  if ((linked ?? []).length > 0) {
    return {
      ok: false,
      reason:
        'Este portfólio ainda tem contas de anúncio monitoradas. Remova as contas antes de desconectar o portfólio.',
    };
  }

  const { error } = await db
    .from('ad_platform_credentials')
    .delete()
    .eq('id', credentialId)
    .eq('account_id', accountId);

  if (error) throw error;
  return { ok: true };
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
