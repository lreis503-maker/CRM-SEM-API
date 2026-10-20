export type RecipientInput =
  | { kind: 'contact'; contactId: string }
  | { kind: 'manual'; name: string; phone: string };

export interface ReminderInput {
  recipient: RecipientInput;
  amountCents: number;
  sendDay: number;
  sendTime: string;
  enabled: boolean;
}

export interface ReminderScheduleInput {
  sendDay: number;
  sendTime: string;
  timeZone: string;
}

export interface MonthlyPaymentReminder {
  id: string;
  account_id: string;
  recipient_kind: RecipientInput['kind'];
  contact_id: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  amount_cents: number;
  currency: string;
  send_day: number;
  send_time: string;
  timezone: string;
  enabled: boolean;
  starts_at: string;
  deleted_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type MonthlyPaymentDeliveryStatus = 'pending' | 'processing' | 'sent' | 'failed';

export interface MonthlyPaymentDelivery {
  id: string;
  reminder_id: string;
  account_id: string;
  competence: string;
  scheduled_for: string;
  status: MonthlyPaymentDeliveryStatus;
  attempts: number;
  processing_at: string | null;
  next_attempt_at: string | null;
  sent_at: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  message: string | null;
  last_error: string | null;
  updated_at: string;
}

