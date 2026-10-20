import type { SupabaseClient } from '@supabase/supabase-js';

import { engineSendText } from '@/lib/automations/meta-send';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { loadProviderTransport } from '@/lib/whatsapp/providers/send-provider-message';

import { buildMonthlyPaymentMessage } from './message';
import type { MonthlyPaymentDelivery, MonthlyPaymentReminder } from './types';

export interface ClaimedMonthlyPayment {
  delivery: MonthlyPaymentDelivery;
  reminder: MonthlyPaymentReminder;
}

export interface SendMonthlyPaymentResult {
  providerMessageId?: string;
  recipientName: string;
  recipientPhone: string;
  message: string;
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
}

export interface SendMonthlyPaymentDeps {
  loadContact?: (
    db: SupabaseClient,
    accountId: string,
    contactId: string,
  ) => Promise<ContactRow | null>;
  resolveConversation?: (
    db: SupabaseClient,
    accountId: string,
    contact: ContactRow,
  ) => Promise<{ conversationId: string; contactId: string; userId: string }>;
  engineSend?: typeof engineSendText;
  directSend?: (
    accountId: string,
    phone: string,
    text: string,
    trackId: string,
  ) => Promise<{ externalMessageId?: string }>;
}

async function defaultLoadContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<ContactRow | null> {
  const { data, error } = await db
    .from('contacts')
    .select('id, name, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data as ContactRow | null;
}

async function defaultResolveConversation(
  db: SupabaseClient,
  accountId: string,
  contact: ContactRow,
): Promise<{ conversationId: string; contactId: string; userId: string }> {
  const resolved = await resolveConversationByPhone(db, accountId, contact.phone ?? '', contact.name);
  const { data, error } = await db
    .from('conversations')
    .select('user_id')
    .eq('id', resolved.conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  const userId = (data as { user_id?: string } | null)?.user_id;
  if (!userId) throw new Error('Não foi possível identificar o responsável pela conversa');
  return { conversationId: resolved.conversationId, contactId: resolved.contactId, userId };
}

export async function sendMonthlyPaymentMessage(
  input: {
    db: SupabaseClient;
    reminder: MonthlyPaymentReminder;
    competence: string;
    trackId: string;
  },
  deps: SendMonthlyPaymentDeps = {},
): Promise<SendMonthlyPaymentResult> {
  const { db, reminder, competence, trackId } = input;
  let recipientName: string;
  let recipientPhone: string;

  if (reminder.recipient_kind === 'contact') {
    if (!reminder.contact_id) throw new Error('O contato selecionado não existe mais');
    const loadContact = deps.loadContact ?? defaultLoadContact;
    const contact = await loadContact(db, reminder.account_id, reminder.contact_id);
    if (!contact) throw new Error('O contato selecionado não existe mais');
    recipientName = contact.name?.trim() || '';
    recipientPhone = contact.phone?.trim() || '';
    if (!recipientName) throw new Error('O contato selecionado está sem nome');
    if (!recipientPhone) throw new Error('O contato selecionado está sem telefone');

    const resolveConversation = deps.resolveConversation ?? defaultResolveConversation;
    const conversation = await resolveConversation(db, reminder.account_id, contact);
    const message = buildMonthlyPaymentMessage({
      recipientName,
      competence,
      amountCents: reminder.amount_cents,
      currency: reminder.currency,
    });
    const sent = await (deps.engineSend ?? engineSendText)({
      accountId: reminder.account_id,
      userId: conversation.userId,
      conversationId: conversation.conversationId,
      contactId: conversation.contactId,
      text: message,
    });
    return {
      providerMessageId: sent.whatsapp_message_id,
      recipientName,
      recipientPhone,
      message,
    };
  }

  recipientName = reminder.recipient_name?.trim() || '';
  recipientPhone = reminder.recipient_phone?.trim() || '';
  if (!recipientName || !recipientPhone) throw new Error('O destinatário avulso está incompleto');
  const message = buildMonthlyPaymentMessage({
    recipientName,
    competence,
    amountCents: reminder.amount_cents,
    currency: reminder.currency,
  });

  const directSend = deps.directSend ?? (async (accountId, phone, text, id) => {
    const { transport } = await loadProviderTransport(db, accountId);
    const sent = await transport.send(phone.replace(/\D/g, ''), { kind: 'text', text, trackId: id });
    return { externalMessageId: sent.externalMessageId };
  });
  const sent = await directSend(reminder.account_id, recipientPhone, message, trackId);
  return {
    providerMessageId: sent.externalMessageId,
    recipientName,
    recipientPhone,
    message,
  };
}

async function defaultClaim(
  db: SupabaseClient,
  now: Date,
  limit: number,
  holder: string,
): Promise<ClaimedMonthlyPayment[]> {
  const { data: claimed, error: claimError } = await db.rpc(
    'claim_due_monthly_payment_deliveries',
    { p_now: now.toISOString(), p_limit: limit, p_holder: holder },
  );
  if (claimError) throw claimError;
  const ids = ((claimed ?? []) as Array<{ delivery_id: string }>).map((row) => row.delivery_id);
  if (ids.length === 0) return [];

  const { data: deliveries, error: deliveriesError } = await db
    .from('monthly_payment_deliveries')
    .select('*')
    .in('id', ids);
  if (deliveriesError) throw deliveriesError;
  const deliveryRows = (deliveries ?? []) as MonthlyPaymentDelivery[];
  const reminderIds = [...new Set(deliveryRows.map((row) => row.reminder_id))];
  const { data: reminders, error: remindersError } = await db
    .from('monthly_payment_reminders')
    .select('*')
    .in('id', reminderIds);
  if (remindersError) throw remindersError;
  const byId = new Map(
    ((reminders ?? []) as MonthlyPaymentReminder[]).map((row) => [row.id, row]),
  );
  return deliveryRows.flatMap((delivery) => {
    const reminder = byId.get(delivery.reminder_id);
    return reminder ? [{ delivery, reminder }] : [];
  });
}

export interface RunMonthlyPaymentDeps {
  claim?: (
    db: SupabaseClient,
    now: Date,
    limit: number,
    holder: string,
  ) => Promise<ClaimedMonthlyPayment[]>;
  send?: (
    input: Parameters<typeof sendMonthlyPaymentMessage>[0],
  ) => Promise<SendMonthlyPaymentResult>;
}

export async function runMonthlyPaymentDeliveries(
  db: SupabaseClient,
  options: { now?: Date; limit?: number; holder?: string } = {},
  deps: RunMonthlyPaymentDeps = {},
): Promise<{ claimed: number; sent: number; failed: number }> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const holder = options.holder ?? `${process.pid}@${now.toISOString()}`;
  const claimed = await (deps.claim ?? defaultClaim)(db, now, limit, holder);
  const result = { claimed: claimed.length, sent: 0, failed: 0 };

  for (const item of claimed) {
    try {
      const sent = await (deps.send ?? ((args) => sendMonthlyPaymentMessage(args)))({
        db,
        reminder: item.reminder,
        competence: item.delivery.competence,
        trackId: `monthly-payment:${item.delivery.id}`,
      });
      const { error } = await db
        .from('monthly_payment_deliveries')
        .update({
          status: 'sent',
          processing_at: null,
          next_attempt_at: null,
          sent_at: now.toISOString(),
          recipient_name: sent.recipientName,
          recipient_phone: sent.recipientPhone,
          message: sent.message,
          provider_message_id: sent.providerMessageId ?? null,
          last_error: null,
          updated_at: now.toISOString(),
        })
        .eq('id', item.delivery.id)
        .eq('account_id', item.delivery.account_id);
      if (error) throw error;
      result.sent++;
    } catch (error) {
      const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await db
        .from('monthly_payment_deliveries')
        .update({
          status: 'failed',
          processing_at: null,
          next_attempt_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
          last_error: lastError,
          updated_at: now.toISOString(),
        })
        .eq('id', item.delivery.id)
        .eq('account_id', item.delivery.account_id);
      result.failed++;
    }
  }
  return result;
}

