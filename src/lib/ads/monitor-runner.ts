/**
 * O ciclo de verificação: lê as contas de anúncio monitoradas,
 * aplica a regra e manda o aviso pelo WhatsApp que a conta do CRM
 * tem ativo.
 *
 * O que este arquivo deliberadamente NÃO faz:
 *
 * - não decide texto (isso é `alert-message.ts`);
 * - não decide se avisa (isso é `account-health.ts`);
 * - não fala com a Meta (isso é `meta-ads-client.ts`).
 *
 * Aqui só mora a ordem das coisas e o que acontece quando um passo
 * falha. Toda dependência externa entra por `deps` para o teste poder
 * rodar o ciclo inteiro sem rede e sem banco real.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { engineSendText } from '@/lib/automations/meta-send';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { loadProviderTransport } from '@/lib/whatsapp/providers/send-provider-message';

import {
  decideAlerts,
  evaluateAdAccountHealth,
  type AlertKind,
  type MonitorAlertState,
} from './account-health';
import { buildClientMessage, buildInternalMessage } from './alert-message';
import { loadCredentialToken } from './credentials';
import {
  createMetaAdsClient,
  type MetaAdAccountSnapshot,
  type MetaAdsClient,
} from './meta-ads-client';
import { MetaAdsClientError } from './meta-ads-errors';

/**
 * Quantas falhas repetíveis seguidas antes de incomodar a equipe.
 *
 * Uma instabilidade da Meta que se resolve sozinha não deve virar
 * mensagem no WhatsApp; três ciclos seguidos já não é instabilidade.
 */
const RETRYABLE_FAILURE_ALERT_AT = 3;

export interface MonitorRow {
  id: string;
  account_id: string;
  /**
   * Portfólio cujo token lê esta conta. Nulo só em linha antiga que a
   * migração 048 não conseguiu atribuir — o ciclo pula e grava o
   * motivo, em vez de tentar adivinhar o portfólio.
   */
  credential_id: string | null;
  external_account_id: string;
  display_name: string | null;
  contact_id: string | null;
  low_balance_threshold_cents: number;
  currency: string | null;
  notify_client: boolean;
  notify_internal: boolean;
  cooldown_hours: number;
}

export interface RunAdMonitorsOptions {
  /** Teto de monitores por execução, para o ciclo não estourar tempo. */
  limit?: number;
  /**
   * Não relê uma conta verificada há menos que isto. Permite apontar
   * um cron de 5 minutos sem multiplicar chamadas na Meta.
   */
  minIntervalMinutes?: number;
  /** Restringe a uma conta do CRM (usado pelo botão "verificar agora"). */
  accountId?: string;
  /** Restringe a um monitor. */
  monitorId?: string;
}

export interface RunAdMonitorsDeps {
  now?: Date;
  createClient?: (accessToken: string) => MetaAdsClient;
  /** Envia para o contato do cliente e registra na caixa de entrada. */
  sendToContact?: (input: {
    db: SupabaseClient;
    accountId: string;
    contactId: string;
    text: string;
  }) => Promise<void>;
  /** Envia para um número solto (a cópia interna), sem criar contato. */
  sendToPhone?: (input: {
    db: SupabaseClient;
    accountId: string;
    phone: string;
    text: string;
    trackId: string;
  }) => Promise<void>;
}

export interface RunAdMonitorsResult {
  checked: number;
  skipped: number;
  alerts: number;
  failures: number;
}

// --- envio (implementações padrão) ----------------------------------------

/**
 * A mensagem do cliente entra pela mesma porta das automações, então
 * ela aparece na conversa do CRM com o provedor certo, o id real da
 * mensagem e o histórico junto do resto do atendimento — em vez de
 * sumir num envio paralelo que ninguém vê depois.
 */
async function defaultSendToContact(input: {
  db: SupabaseClient;
  accountId: string;
  contactId: string;
  text: string;
}): Promise<void> {
  const { db, accountId, contactId, text } = input;

  const { data: contact, error } = await db
    .from('contacts')
    .select('id, name, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) throw error;
  if (!contact) throw new Error('O contato vinculado não existe mais.');

  const phone = (contact as { phone?: unknown }).phone;
  if (typeof phone !== 'string' || phone.trim().length === 0) {
    throw new Error('O contato vinculado não tem telefone.');
  }

  const resolved = await resolveConversationByPhone(
    db,
    accountId,
    phone,
    (contact as { name?: string | null }).name ?? null
  );

  // `conversations.user_id` é o dono da conversa e sempre existe; o
  // monitor pode ter sido criado por alguém que já saiu da equipe,
  // então ele não serve como autor do envio.
  const { data: conversation } = await db
    .from('conversations')
    .select('user_id')
    .eq('id', resolved.conversationId)
    .maybeSingle();

  await engineSendText({
    accountId,
    userId: String((conversation as { user_id?: unknown })?.user_id ?? ''),
    conversationId: resolved.conversationId,
    contactId: resolved.contactId,
    text,
  });
}

/**
 * A cópia interna vai direto pelo transporte, sem contato e sem
 * conversa: é a equipe da agência, não um cliente, e criar um contato
 * do CRM para ela sujaria a lista e o funil.
 */
async function defaultSendToPhone(input: {
  db: SupabaseClient;
  accountId: string;
  phone: string;
  text: string;
  trackId: string;
}): Promise<void> {
  const { transport } = await loadProviderTransport(input.db, input.accountId);
  await transport.send(input.phone.replace(/[^\d]/g, ''), {
    kind: 'text',
    text: input.text,
    trackId: input.trackId,
  });
}

// --- leitura de estado ----------------------------------------------------

function toDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface StoredState extends MonitorAlertState {
  checkedAt: Date | null;
  consecutiveFailures: number;
}

const EMPTY_STATE: StoredState = {
  checkedAt: null,
  consecutiveFailures: 0,
  lowBalanceActive: false,
  lowBalanceAlertAt: null,
  paymentIssueActive: false,
  paymentIssueAlertAt: null,
  paymentIssueCode: null,
};

function mapState(row: Record<string, unknown>): StoredState {
  return {
    checkedAt: toDate(row.checked_at),
    consecutiveFailures:
      typeof row.consecutive_failures === 'number'
        ? row.consecutive_failures
        : 0,
    lowBalanceActive: row.low_balance_active === true,
    lowBalanceAlertAt: toDate(row.low_balance_alert_at),
    paymentIssueActive: row.payment_issue_active === true,
    paymentIssueAlertAt: toDate(row.payment_issue_alert_at),
    paymentIssueCode:
      typeof row.payment_issue_code === 'string' ? row.payment_issue_code : null,
  };
}

// --- ciclo ----------------------------------------------------------------

export async function runAdAccountMonitors(
  db: SupabaseClient,
  options: RunAdMonitorsOptions = {},
  deps: RunAdMonitorsDeps = {}
): Promise<RunAdMonitorsResult> {
  const now = deps.now ?? new Date();
  const limit = options.limit ?? 100;
  const minIntervalMs = (options.minIntervalMinutes ?? 0) * 60_000;
  const createClient =
    deps.createClient ??
    ((accessToken: string) => createMetaAdsClient({ accessToken }));
  const sendToContact = deps.sendToContact ?? defaultSendToContact;
  const sendToPhone = deps.sendToPhone ?? defaultSendToPhone;

  let query = db
    .from('ad_account_monitors')
    .select(
      'id, account_id, credential_id, external_account_id, display_name, contact_id, low_balance_threshold_cents, currency, notify_client, notify_internal, cooldown_hours'
    )
    .eq('enabled', true)
    .eq('platform', 'meta')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (options.accountId) query = query.eq('account_id', options.accountId);
  if (options.monitorId) query = query.eq('id', options.monitorId);

  const { data: monitorRows, error: monitorError } = await query;
  if (monitorError) throw monitorError;

  const monitors = (monitorRows ?? []) as unknown as MonitorRow[];
  const result: RunAdMonitorsResult = {
    checked: 0,
    skipped: 0,
    alerts: 0,
    failures: 0,
  };
  if (monitors.length === 0) return result;

  const { data: stateRows, error: stateError } = await db
    .from('ad_account_monitor_state')
    .select('*')
    .in(
      'monitor_id',
      monitors.map((monitor) => monitor.id)
    );
  if (stateError) throw stateError;

  const states = new Map<string, StoredState>();
  for (const row of (stateRows ?? []) as Record<string, unknown>[]) {
    states.set(String(row.monitor_id), mapState(row));
  }

  // Os portfólios envolvidos neste lote, lidos de uma vez. Só os
  // metadados: o token de cada um é decifrado sob demanda, logo abaixo,
  // e no máximo uma vez por ciclo.
  const credentialIds = [
    ...new Set(
      monitors
        .map((monitor) => monitor.credential_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ];

  const internalPhones = new Map<string, string | null>();
  if (credentialIds.length > 0) {
    const { data: credentialRows, error: credentialError } = await db
      .from('ad_platform_credentials')
      .select('id, internal_notify_phone')
      .in('id', credentialIds);
    if (credentialError) throw credentialError;

    for (const row of (credentialRows ?? []) as Record<string, unknown>[]) {
      internalPhones.set(
        String(row.id),
        typeof row.internal_notify_phone === 'string'
          ? row.internal_notify_phone
          : null
      );
    }
  }

  const tokens = new Map<string, string | null>();

  for (const monitor of monitors) {
    const state = states.get(monitor.id) ?? EMPTY_STATE;

    if (
      minIntervalMs > 0 &&
      state.checkedAt !== null &&
      now.getTime() - state.checkedAt.getTime() < minIntervalMs
    ) {
      result.skipped++;
      continue;
    }

    // Sem token não há o que ler. Fica gravado para a tela mostrar, e
    // nada é enviado: quem precisa configurar já está dentro do CRM.
    const credentialId = monitor.credential_id;
    if (credentialId === null) {
      await writeState(
        db,
        monitor,
        { ...state, consecutiveFailures: state.consecutiveFailures + 1 },
        now,
        null,
        'Escolha o portfólio desta conta em Monitoramento de contas de anúncio.'
      );
      result.failures++;
      continue;
    }

    if (!tokens.has(credentialId)) {
      tokens.set(credentialId, await loadCredentialToken(db, credentialId));
    }

    const accessToken = tokens.get(credentialId) ?? null;
    const internalPhone = internalPhones.get(credentialId) ?? null;

    if (accessToken === null) {
      await writeState(
        db,
        monitor,
        { ...state, consecutiveFailures: state.consecutiveFailures + 1 },
        now,
        null,
        'Este portfólio está sem token. Cole o token do Business Manager de novo.'
      );
      result.failures++;
      continue;
    }

    let snapshot: MetaAdAccountSnapshot;
    try {
      snapshot = await createClient(accessToken).readAdAccount(
        monitor.external_account_id
      );
    } catch (error) {
      result.failures++;
      await handleReadFailure({
        db,
        monitor,
        state,
        now,
        error,
        internalPhone,
        sendToPhone,
      });
      continue;
    }

    result.checked++;

    const health = evaluateAdAccountHealth(snapshot);
    const decision = decideAlerts({
      health,
      previous: state,
      thresholdCents: monitor.low_balance_threshold_cents,
      cooldownHours: monitor.cooldown_hours,
      now,
    });

    const currency = snapshot.currency ?? monitor.currency ?? 'BRL';
    const accountLabel =
      snapshot.name ?? monitor.display_name ?? `act_${monitor.external_account_id}`;

    for (const alert of decision.alerts) {
      await deliverAlert({
        db,
        monitor,
        alert: alert.kind,
        reasonCode: alert.reasonCode,
        accountLabel,
        currency,
        availableCents: health.availableCents,
        snapshot,
        internalPhone,
        sendToContact,
        sendToPhone,
      });
      result.alerts++;
    }

    await writeState(
      db,
      monitor,
      { ...decision.next, checkedAt: now, consecutiveFailures: 0 },
      now,
      { snapshot, availableCents: health.availableCents, currency }
    );

    // O nome e a moeda vêm da Meta; mantê-los no monitor deixa a tela
    // legível mesmo quando a credencial para de funcionar.
    if (
      snapshot.name !== null &&
      (snapshot.name !== monitor.display_name || currency !== monitor.currency)
    ) {
      await db
        .from('ad_account_monitors')
        .update({
          display_name: snapshot.name,
          currency,
          updated_at: now.toISOString(),
        })
        .eq('id', monitor.id);
    }
  }

  return result;
}

// --- gravação -------------------------------------------------------------

async function writeState(
  db: SupabaseClient,
  monitor: MonitorRow,
  state: StoredState,
  now: Date,
  reading: {
    snapshot: MetaAdAccountSnapshot;
    availableCents: number | null;
    currency: string;
  } | null,
  lastError: string | null = null
): Promise<void> {
  const patch: Record<string, unknown> = {
    monitor_id: monitor.id,
    account_id: monitor.account_id,
    low_balance_active: state.lowBalanceActive,
    low_balance_alert_at: state.lowBalanceAlertAt?.toISOString() ?? null,
    payment_issue_active: state.paymentIssueActive,
    payment_issue_alert_at: state.paymentIssueAlertAt?.toISOString() ?? null,
    payment_issue_code: state.paymentIssueCode,
    consecutive_failures: state.consecutiveFailures,
    last_error: lastError,
    updated_at: now.toISOString(),
  };

  if (reading !== null) {
    patch.checked_at = now.toISOString();
    // `balance_cents` guarda a fatura em aberto da Meta, não o saldo.
    // O saldo comparado com o limite é `available_cents`.
    patch.balance_cents = reading.snapshot.amountDueCents;
    patch.amount_spent_cents = reading.snapshot.amountSpentCents;
    patch.spend_cap_cents = reading.snapshot.spendCapCents;
    patch.available_cents = reading.availableCents;
    patch.currency = reading.currency;
    patch.is_prepay_account = reading.snapshot.isPrepayAccount;
    patch.account_status = reading.snapshot.accountStatus;
    patch.disable_reason = reading.snapshot.disableReason;
    patch.has_funding_source = reading.snapshot.hasFundingSource;
    patch.funding_source_display = reading.snapshot.fundingSourceDisplay;
  }

  await db
    .from('ad_account_monitor_state')
    .upsert(patch, { onConflict: 'monitor_id' });
}

async function deliverAlert(input: {
  db: SupabaseClient;
  monitor: MonitorRow;
  alert: AlertKind;
  reasonCode: string;
  accountLabel: string;
  currency: string;
  availableCents: number | null;
  snapshot: MetaAdAccountSnapshot;
  internalPhone: string | null;
  sendToContact: NonNullable<RunAdMonitorsDeps['sendToContact']>;
  sendToPhone: NonNullable<RunAdMonitorsDeps['sendToPhone']>;
}): Promise<void> {
  const { db, monitor, alert } = input;

  const { data: contact } = monitor.contact_id
    ? await db
        .from('contacts')
        .select('id, name')
        .eq('id', monitor.contact_id)
        .eq('account_id', monitor.account_id)
        .maybeSingle()
    : { data: null };

  const context = {
    accountLabel: input.accountLabel,
    externalAccountId: monitor.external_account_id,
    contactName: (contact as { name?: string | null } | null)?.name ?? null,
    currency: input.currency,
    availableCents: input.availableCents,
    thresholdCents: monitor.low_balance_threshold_cents,
    reasonCode: input.reasonCode,
  };

  const clientText = buildClientMessage(alert, context);
  const internalText = buildInternalMessage(alert, context);

  // A linha do histórico nasce antes do envio para o seu id poder
  // viajar como identificador de rastreio do provedor. Se o envio
  // falhar, a linha fica com o erro em vez de sumir — um alerta que
  // não saiu é exatamente o que alguém precisa conseguir ver depois.
  const { data: alertRow } = await db
    .from('ad_account_alerts')
    .insert({
      account_id: monitor.account_id,
      monitor_id: monitor.id,
      kind: alert,
      reason_code: input.reasonCode,
      message: clientText,
      contact_id: monitor.contact_id,
      delivery_status: 'skipped',
      snapshot: {
        amount_due_cents: input.snapshot.amountDueCents,
        amount_spent_cents: input.snapshot.amountSpentCents,
        spend_cap_cents: input.snapshot.spendCapCents,
        available_cents: input.availableCents,
        available_funds_cents: input.snapshot.availableFundsCents,
        funding_source_display: input.snapshot.fundingSourceDisplay,
        funding_source_type: input.snapshot.fundingSourceType,
        currency: input.currency,
        account_status: input.snapshot.accountStatus,
        disable_reason: input.snapshot.disableReason,
        has_funding_source: input.snapshot.hasFundingSource,
        is_prepay_account: input.snapshot.isPrepayAccount,
      },
    })
    .select('id')
    .single();

  const alertId = String((alertRow as { id?: unknown })?.id ?? '');

  let clientError: string | null = null;
  let internalError: string | null = null;
  let clientAttempted = false;
  let internalAttempted = false;

  if (monitor.notify_client && monitor.contact_id && contact) {
    clientAttempted = true;
    try {
      await input.sendToContact({
        db,
        accountId: monitor.account_id,
        contactId: monitor.contact_id,
        text: clientText,
      });
    } catch (error) {
      clientError = describeError(error);
    }
  }

  if (monitor.notify_internal && input.internalPhone) {
    internalAttempted = true;
    try {
      await input.sendToPhone({
        db,
        accountId: monitor.account_id,
        phone: input.internalPhone,
        text: internalText,
        trackId: alertId,
      });
    } catch (error) {
      internalError = describeError(error);
    }
  }

  await db
    .from('ad_account_alerts')
    .update({
      delivery_status: summarizeDelivery({
        clientAttempted,
        internalAttempted,
        clientError,
        internalError,
      }),
      client_error: clientError,
      internal_error: internalError,
    })
    .eq('id', alertId);
}

export function summarizeDelivery(input: {
  clientAttempted: boolean;
  internalAttempted: boolean;
  clientError: string | null;
  internalError: string | null;
}): 'sent' | 'partial' | 'failed' | 'skipped' {
  const attempts = [
    input.clientAttempted ? input.clientError === null : null,
    input.internalAttempted ? input.internalError === null : null,
  ].filter((value): value is boolean => value !== null);

  if (attempts.length === 0) return 'skipped';
  if (attempts.every(Boolean)) return 'sent';
  if (attempts.some(Boolean)) return 'partial';
  return 'failed';
}

function describeError(error: unknown): string {
  if (error instanceof MetaAdsClientError) return error.humanMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function handleReadFailure(input: {
  db: SupabaseClient;
  monitor: MonitorRow;
  state: StoredState;
  now: Date;
  error: unknown;
  internalPhone: string | null;
  sendToPhone: NonNullable<RunAdMonitorsDeps['sendToPhone']>;
}): Promise<void> {
  const { db, monitor, state, now, error, internalPhone } = input;
  const failures = state.consecutiveFailures + 1;
  const message = describeError(error);
  const retryable = error instanceof MetaAdsClientError ? error.retryable : true;

  await writeState(
    db,
    monitor,
    { ...state, consecutiveFailures: failures },
    now,
    null,
    message
  );

  // Uma falha que precisa de ação humana avisa na primeira vez; uma
  // falha de infraestrutura só depois de insistir. Em ambos os casos
  // o aviso sai uma vez só, porque a condição usa igualdade: no ciclo
  // seguinte o contador já passou do ponto de disparo.
  const shouldAlert = retryable
    ? failures === RETRYABLE_FAILURE_ALERT_AT
    : failures === 1;
  if (!shouldAlert || !monitor.notify_internal || !internalPhone) return;

  const label =
    monitor.display_name ?? `act_${monitor.external_account_id}`;
  const text =
    `🔌 Não foi possível verificar a conta de anúncios\n` +
    `Conta: ${label} (act_${monitor.external_account_id})\n` +
    `Motivo: ${message}`;

  const { data: alertRow } = await db
    .from('ad_account_alerts')
    .insert({
      account_id: monitor.account_id,
      monitor_id: monitor.id,
      kind: 'read_failed',
      reason_code: error instanceof MetaAdsClientError ? error.kind : 'unknown',
      message: text,
      contact_id: null,
      delivery_status: 'skipped',
    })
    .select('id')
    .single();

  const alertId = String((alertRow as { id?: unknown })?.id ?? '');
  let internalError: string | null = null;
  try {
    await input.sendToPhone({
      db,
      accountId: monitor.account_id,
      phone: internalPhone,
      text,
      trackId: alertId,
    });
  } catch (sendError) {
    internalError = describeError(sendError);
  }

  await db
    .from('ad_account_alerts')
    .update({
      delivery_status: internalError === null ? 'sent' : 'failed',
      internal_error: internalError,
    })
    .eq('id', alertId);
}
