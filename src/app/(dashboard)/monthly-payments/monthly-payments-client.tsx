'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Pencil, Pause, Play, Plus, Send, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ContactChoice {
  id: string;
  name: string | null;
  phone: string | null;
}

interface DeliveryView {
  status: 'pending' | 'processing' | 'sent' | 'failed';
  last_error: string | null;
  sent_at?: string | null;
  competence?: string;
}

export interface ReminderView {
  id: string;
  recipient_kind: 'contact' | 'manual';
  contact_id: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  amount_cents: number;
  currency: string;
  send_day: number;
  send_time: string;
  enabled: boolean;
  next_scheduled_at: string | null;
  last_delivery: DeliveryView | null;
}

interface FormState {
  recipientKind: 'contact' | 'manual';
  contactId: string;
  recipientName: string;
  recipientPhone: string;
  amountText: string;
  sendDay: number;
  sendTime: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  recipientKind: 'contact',
  contactId: '',
  recipientName: '',
  recipientPhone: '',
  amountText: '',
  sendDay: 10,
  sendTime: '09:00',
  enabled: true,
};

const SELECT_CLASS = 'border-input bg-background h-9 w-full rounded-md border px-3 text-sm';

export function amountTextToCents(raw: string): number | null {
  const normalized = raw.trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function buildReminderPayload(form: FormState): Record<string, unknown> {
  const amountCents = amountTextToCents(form.amountText);
  if (amountCents === null) throw new Error('Informe um valor maior que zero.');
  const common = {
    amount_cents: amountCents,
    send_day: form.sendDay,
    send_time: form.sendTime,
    enabled: form.enabled,
  };
  return form.recipientKind === 'contact'
    ? { ...common, recipient_kind: 'contact', contact_id: form.contactId }
    : {
        ...common,
        recipient_kind: 'manual',
        recipient_name: form.recipientName,
        recipient_phone: form.recipientPhone,
      };
}

function money(cents: number, currency = 'BRL'): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(cents / 100);
}

function contactLabel(contact: ContactChoice): string {
  return contact.name?.trim() || contact.phone || contact.id;
}

function formFromReminder(reminder: ReminderView): FormState {
  return {
    recipientKind: reminder.recipient_kind,
    contactId: reminder.contact_id ?? '',
    recipientName: reminder.recipient_name ?? '',
    recipientPhone: reminder.recipient_phone ?? '',
    amountText: (reminder.amount_cents / 100).toFixed(2).replace('.', ','),
    sendDay: reminder.send_day,
    sendTime: reminder.send_time.slice(0, 5),
    enabled: reminder.enabled,
  };
}

export function MonthlyPaymentSummary({
  reminder,
  contactName,
}: {
  reminder: ReminderView;
  contactName: string | null;
}) {
  const name = contactName || reminder.recipient_name || reminder.recipient_phone || 'Sem destinatário';
  const next = reminder.next_scheduled_at
    ? new Date(reminder.next_scheduled_at).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : null;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="truncate font-medium">{name}</p>
        <Badge variant={reminder.enabled ? 'default' : 'secondary'}>
          {reminder.enabled ? 'Ativa' : 'Pausada'}
        </Badge>
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums">
        {money(reminder.amount_cents, reminder.currency)}
      </p>
      <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-sm">
        <CalendarDays className="size-4" aria-hidden="true" />
        {next ? `Próximo envio: ${next}` : 'Sem envio enquanto estiver pausada'}
      </p>
      {reminder.last_delivery?.status === 'failed' ? (
        <p className="text-destructive mt-2 text-sm">{reminder.last_delivery.last_error}</p>
      ) : reminder.last_delivery?.status === 'sent' ? (
        <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">Último envio concluído</p>
      ) : null}
    </div>
  );
}

export function MonthlyPaymentsClient() {
  const t = useTranslations('MonthlyPayments');
  const [reminders, setReminders] = useState<ReminderView[]>([]);
  const [contacts, setContacts] = useState<ContactChoice[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, DeliveryView[]>>({});

  const contactNames = useMemo(
    () => new Map(contacts.map((contact) => [contact.id, contactLabel(contact)])),
    [contacts],
  );

  const load = useCallback(async () => {
    setError(null);
    const response = await fetch('/api/monthly-payments');
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('loadError'));
    setReminders(body.reminders ?? []);
    setContacts(body.contacts ?? []);
    setProvider(body.whatsapp_provider ?? null);
  }, [t]);

  useEffect(() => {
    void load()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('loadError')))
      .finally(() => setLoading(false));
  }, [load, t]);

  const request = async (url: string, init: RequestInit, success: string) => {
    setError(null);
    setNotice(null);
    const response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('actionError'));
    setNotice(success);
    await load();
    return body;
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, contactId: contacts[0]?.id ?? '' });
    setShowForm(true);
  };

  const openEdit = (reminder: ReminderView) => {
    setEditingId(reminder.id);
    setForm(formFromReminder(reminder));
    setShowForm(true);
  };

  const submit = async () => {
    try {
      const payload = buildReminderPayload(form);
      setBusyId(editingId ?? 'new');
      await request(
        editingId ? `/api/monthly-payments/${editingId}` : '/api/monthly-payments',
        { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(payload) },
        editingId ? t('updated') : t('created'),
      );
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('actionError'));
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (reminder: ReminderView) => {
    try {
      setBusyId(reminder.id);
      await request(
        `/api/monthly-payments/${reminder.id}`,
        { method: 'PUT', body: JSON.stringify({ enabled: !reminder.enabled }) },
        reminder.enabled ? t('paused') : t('resumed'),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('actionError'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (reminder: ReminderView) => {
    if (!window.confirm(t('deleteConfirm'))) return;
    try {
      setBusyId(reminder.id);
      await request(`/api/monthly-payments/${reminder.id}`, { method: 'DELETE' }, t('deleted'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('actionError'));
    } finally {
      setBusyId(null);
    }
  };

  const testSend = async (reminder: ReminderView) => {
    try {
      setBusyId(reminder.id);
      await request(`/api/monthly-payments/${reminder.id}/test`, { method: 'POST' }, t('testSent'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('actionError'));
    } finally {
      setBusyId(null);
    }
  };

  const loadHistory = async (id: string) => {
    if (history[id]) {
      setHistory((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return;
    }
    const response = await fetch(`/api/monthly-payments/${id}/deliveries`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return setError(body.error || t('actionError'));
    setHistory((current) => ({ ...current, [id]: body.deliveries ?? [] }));
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">{t('description')}</p>
        </div>
        <Button onClick={openCreate} className="sm:self-auto">
          <Plus className="size-4" /> {t('new')}
        </Button>
      </header>

      {provider === 'meta' ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          {t('metaWarning')}
        </div>
      ) : null}
      {error ? <div role="alert" className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border p-3 text-sm">{error}</div> : null}
      {notice ? <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">{notice}</div> : null}

      {showForm ? (
        <ReminderForm
          form={form}
          contacts={contacts}
          editing={editingId !== null}
          pending={busyId === (editingId ?? 'new')}
          onChange={setForm}
          onCancel={() => setShowForm(false)}
          onSubmit={() => void submit()}
        />
      ) : null}

      {loading ? (
        <Card><CardContent className="p-6 text-sm">{t('loading')}</CardContent></Card>
      ) : reminders.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle>{t('emptyTitle')}</CardTitle>
            <CardDescription>{t('emptyDescription')}</CardDescription>
          </CardHeader>
          <CardContent><Button onClick={openCreate}>{t('createFirst')}</Button></CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {reminders.map((reminder) => (
            <Card key={reminder.id} className="overflow-hidden">
              <CardContent className="p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <MonthlyPaymentSummary
                    reminder={reminder}
                    contactName={reminder.contact_id ? contactNames.get(reminder.contact_id) ?? null : null}
                  />
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                    <Button variant="outline" size="sm" disabled={busyId === reminder.id} onClick={() => void testSend(reminder)}>
                      <Send className="size-4" /> {t('test')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openEdit(reminder)}>
                      <Pencil className="size-4" /> {t('edit')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={busyId === reminder.id} onClick={() => void toggle(reminder)}>
                      {reminder.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                      {reminder.enabled ? t('pause') : t('resume')}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive" disabled={busyId === reminder.id} onClick={() => void remove(reminder)}>
                      <Trash2 className="size-4" /> {t('delete')}
                    </Button>
                  </div>
                </div>
                <button type="button" className="text-muted-foreground mt-4 text-sm underline-offset-4 hover:underline" onClick={() => void loadHistory(reminder.id)}>
                  {history[reminder.id] ? t('hideHistory') : t('showHistory')}
                </button>
                {history[reminder.id] ? <DeliveryHistory deliveries={history[reminder.id]} /> : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ReminderForm({ form, contacts, editing, pending, onChange, onCancel, onSubmit }: {
  form: FormState;
  contacts: ContactChoice[];
  editing: boolean;
  pending: boolean;
  onChange: (form: FormState) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations('MonthlyPayments');
  const previewName = form.recipientKind === 'contact'
    ? contactLabel(contacts.find((contact) => contact.id === form.contactId) ?? { id: '', name: null, phone: null })
    : form.recipientName || t('customer');
  const previewAmount = amountTextToCents(form.amountText);
  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle>{editing ? t('editTitle') : t('createTitle')}</CardTitle>
        <CardDescription>{t('formDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="recipient-kind">{t('recipientType')}</Label>
            <select id="recipient-kind" className={SELECT_CLASS} value={form.recipientKind} onChange={(e) => onChange({ ...form, recipientKind: e.target.value as FormState['recipientKind'] })}>
              <option value="contact">{t('crmContact')}</option>
              <option value="manual">{t('manualNumber')}</option>
            </select>
          </div>
          {form.recipientKind === 'contact' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="contact-id">{t('contact')}</Label>
              <select id="contact-id" className={SELECT_CLASS} value={form.contactId} onChange={(e) => onChange({ ...form, contactId: e.target.value })}>
                <option value="">{t('selectContact')}</option>
                {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contactLabel(contact)}</option>)}
              </select>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5"><Label htmlFor="recipient-name">{t('name')}</Label><Input id="recipient-name" value={form.recipientName} onChange={(e) => onChange({ ...form, recipientName: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="recipient-phone">{t('phone')}</Label><Input id="recipient-phone" placeholder="+5511999999999" value={form.recipientPhone} onChange={(e) => onChange({ ...form, recipientPhone: e.target.value })} /></div>
            </>
          )}
          <div className="flex flex-col gap-1.5"><Label htmlFor="amount">{t('amount')}</Label><Input id="amount" inputMode="decimal" placeholder="500,00" value={form.amountText} onChange={(e) => onChange({ ...form, amountText: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5"><Label htmlFor="send-day">{t('day')}</Label><Input id="send-day" type="number" min={1} max={31} value={form.sendDay} onChange={(e) => onChange({ ...form, sendDay: Number(e.target.value) })} /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="send-time">{t('time')}</Label><Input id="send-time" type="time" value={form.sendTime} onChange={(e) => onChange({ ...form, sendTime: e.target.value })} /></div>
          </div>
        </div>
        <div className="bg-muted/50 rounded-lg border p-3 text-sm leading-6">
          <p>🤖 *Mensagem automática*</p>
          <p>Olá, {previewName}! A mensalidade referente ao mês será no valor de {previewAmount ? money(previewAmount) : 'R$ 0,00'}.</p>
          <p>Quando for realizar o pagamento, me chame por aqui para eu enviar o Pix.</p>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button disabled={pending} onClick={onSubmit}>{pending ? t('saving') : t('save')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DeliveryHistory({ deliveries }: { deliveries: DeliveryView[] }) {
  const t = useTranslations('MonthlyPayments');
  if (deliveries.length === 0) return <p className="text-muted-foreground mt-3 text-sm">{t('noHistory')}</p>;
  return (
    <ul className="mt-3 divide-y rounded-md border px-3">
      {deliveries.map((delivery, index) => (
        <li key={`${delivery.competence ?? 'delivery'}-${index}`} className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:justify-between">
          <span>{delivery.competence ?? t('unknownCompetence')}</span>
          <span className={delivery.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
            {delivery.status === 'sent' ? t('sent') : delivery.status === 'failed' ? delivery.last_error || t('failed') : t('sending')}
          </span>
        </li>
      ))}
    </ul>
  );
}

