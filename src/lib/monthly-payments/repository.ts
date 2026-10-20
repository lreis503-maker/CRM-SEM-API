import type { SupabaseClient } from '@supabase/supabase-js';

import { nextScheduledInstant } from './schedule';
import type {
  MonthlyPaymentDelivery,
  MonthlyPaymentReminder,
  ReminderInput,
} from './types';

export class MonthlyPaymentNotFoundError extends Error {
  constructor(message = 'Mensalidade não encontrada') {
    super(message);
    this.name = 'MonthlyPaymentNotFoundError';
  }
}

export class MonthlyPaymentRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonthlyPaymentRepositoryError';
  }
}

function throwIfError(error: { message?: string } | null | undefined): void {
  if (error) throw new MonthlyPaymentRepositoryError(error.message ?? 'Falha no banco de dados');
}

async function assertContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<void> {
  const { data, error } = await db
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  throwIfError(error);
  if (!data) throw new MonthlyPaymentRepositoryError('O contato informado não existe nesta conta');
}

function inputRow(input: ReminderInput): Record<string, unknown> {
  return {
    recipient_kind: input.recipient.kind,
    contact_id: input.recipient.kind === 'contact' ? input.recipient.contactId : null,
    recipient_name: input.recipient.kind === 'manual' ? input.recipient.name : null,
    recipient_phone: input.recipient.kind === 'manual' ? input.recipient.phone : null,
    amount_cents: input.amountCents,
    currency: 'BRL',
    send_day: input.sendDay,
    send_time: input.sendTime,
    timezone: 'America/Sao_Paulo',
    enabled: input.enabled,
  };
}

export async function listReminders(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<Array<MonthlyPaymentReminder & {
  last_delivery: MonthlyPaymentDelivery | null;
  next_scheduled_at: string | null;
}>> {
  const { data, error } = await db
    .from('monthly_payment_reminders')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  throwIfError(error);
  const reminders = (data ?? []) as MonthlyPaymentReminder[];
  if (reminders.length === 0) return [];

  const { data: deliveryData, error: deliveryError } = await db
    .from('monthly_payment_deliveries')
    .select('*')
    .eq('account_id', accountId)
    .in('reminder_id', reminders.map((reminder) => reminder.id))
    .order('created_at', { ascending: false });
  throwIfError(deliveryError);

  const latest = new Map<string, MonthlyPaymentDelivery>();
  for (const delivery of (deliveryData ?? []) as MonthlyPaymentDelivery[]) {
    if (!latest.has(delivery.reminder_id)) latest.set(delivery.reminder_id, delivery);
  }

  return reminders.map((reminder) => ({
    ...reminder,
    last_delivery: latest.get(reminder.id) ?? null,
    next_scheduled_at:
      reminder.enabled
        ? nextScheduledInstant({
            after: now,
            startsAt: new Date(reminder.starts_at),
            sendDay: reminder.send_day,
            sendTime: reminder.send_time.slice(0, 5),
            timeZone: reminder.timezone,
          }).toISOString()
        : null,
  }));
}

export async function getReminder(
  db: SupabaseClient,
  accountId: string,
  id: string,
): Promise<MonthlyPaymentReminder> {
  const { data, error } = await db
    .from('monthly_payment_reminders')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .maybeSingle();
  throwIfError(error);
  if (!data) throw new MonthlyPaymentNotFoundError();
  return data as MonthlyPaymentReminder;
}

export async function createReminder(
  db: SupabaseClient,
  context: { accountId: string; userId: string },
  input: ReminderInput,
  now: Date = new Date(),
): Promise<MonthlyPaymentReminder> {
  if (input.recipient.kind === 'contact') {
    await assertContact(db, context.accountId, input.recipient.contactId);
  }
  const { data, error } = await db
    .from('monthly_payment_reminders')
    .insert({
      account_id: context.accountId,
      created_by: context.userId,
      starts_at: now.toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      ...inputRow(input),
    })
    .select('*')
    .single();
  throwIfError(error);
  return data as MonthlyPaymentReminder;
}

export async function updateReminder(
  db: SupabaseClient,
  context: { accountId: string; userId: string },
  id: string,
  input: ReminderInput,
  now: Date = new Date(),
): Promise<MonthlyPaymentReminder> {
  const existing = await getReminder(db, context.accountId, id);
  if (input.recipient.kind === 'contact') {
    await assertContact(db, context.accountId, input.recipient.contactId);
  }
  const patch: Record<string, unknown> = { ...inputRow(input), updated_at: now.toISOString() };
  if (!existing.enabled && input.enabled) patch.starts_at = now.toISOString();
  const { data, error } = await db
    .from('monthly_payment_reminders')
    .update(patch)
    .eq('id', id)
    .eq('account_id', context.accountId)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  throwIfError(error);
  if (!data) throw new MonthlyPaymentNotFoundError();
  return data as MonthlyPaymentReminder;
}

export async function setReminderEnabled(
  db: SupabaseClient,
  accountId: string,
  id: string,
  enabled: boolean,
  now: Date = new Date(),
): Promise<MonthlyPaymentReminder> {
  const existing = await getReminder(db, accountId, id);
  const patch: Record<string, unknown> = { enabled, updated_at: now.toISOString() };
  if (enabled && !existing.enabled) patch.starts_at = now.toISOString();
  const { data, error } = await db
    .from('monthly_payment_reminders')
    .update(patch)
    .eq('id', id)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  throwIfError(error);
  if (!data) throw new MonthlyPaymentNotFoundError();
  return data as MonthlyPaymentReminder;
}

export async function softDeleteReminder(
  db: SupabaseClient,
  accountId: string,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  const { data, error } = await db
    .from('monthly_payment_reminders')
    .update({ enabled: false, deleted_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  throwIfError(error);
  if (!data) throw new MonthlyPaymentNotFoundError();
}

export async function listDeliveries(
  db: SupabaseClient,
  accountId: string,
  reminderId: string,
  limit = 24,
): Promise<MonthlyPaymentDelivery[]> {
  await getReminder(db, accountId, reminderId);
  const { data, error } = await db
    .from('monthly_payment_deliveries')
    .select('*')
    .eq('account_id', accountId)
    .eq('reminder_id', reminderId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  throwIfError(error);
  return (data ?? []) as MonthlyPaymentDelivery[];
}

export async function listRecipientContacts(db: SupabaseClient, accountId: string) {
  const { data, error } = await db
    .from('contacts')
    .select('id, name, phone')
    .eq('account_id', accountId)
    .order('name', { ascending: true });
  throwIfError(error);
  return data ?? [];
}

