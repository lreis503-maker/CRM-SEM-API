'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  AtSign,
  CalendarClock,
  Check,
  CircleDot,
  ExternalLink,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  PhoneCall,
  Plus,
  Search,
  Sparkles,
  Trash2,
  UserRoundCheck,
  UsersRound,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  COLD_PROSPECT_STATUSES,
  buildAttemptUpdate,
  calculateProspectMetrics,
  normalizeInstagram,
  normalizeWhatsApp,
  validateProspectInput,
  type ColdProspect,
  type ColdProspectStatus,
} from '@/lib/cold-prospects/model';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

interface MemberOption {
  id: string;
  full_name: string | null;
}

interface ProspectFormState {
  name: string;
  instagram: string;
  whatsapp: string;
  company: string;
  niche: string;
  source: string;
  status: ColdProspectStatus;
  attempt_count: string;
  assigned_to: string;
  last_contact_at: string;
  next_follow_up_at: string;
  notes: string;
}

const EMPTY_FORM: ProspectFormState = {
  name: '',
  instagram: '',
  whatsapp: '',
  company: '',
  niche: '',
  source: '',
  status: 'new',
  attempt_count: '0',
  assigned_to: 'unassigned',
  last_contact_at: '',
  next_follow_up_at: '',
  notes: '',
};

const STATUS_STYLES: Record<ColdProspectStatus, string> = {
  new: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  contacted:
    'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  replied: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  interested:
    'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  no_response:
    'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  not_interested:
    'border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-300',
};

function toDateTimeLocal(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function toIsoOrNull(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

function isFollowUpOverdue(prospect: ColdProspect): boolean {
  return (
    prospect.next_follow_up_at !== null &&
    new Date(prospect.next_follow_up_at).getTime() < Date.now() &&
    prospect.status !== 'not_interested'
  );
}

export default function ColdProspectsPage() {
  const t = useTranslations('ColdProspects');
  const { accountId, user, canSendMessages } = useAuth();
  const supabase = createClient();
  const [prospects, setProspects] = useState<ColdProspect[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ColdProspect | null>(null);
  const [form, setForm] = useState<ProspectFormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<ColdProspect | null>(null);

  const fetchData = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const [prospectsResult, membersResult] = await Promise.all([
      supabase
        .from('cold_prospects')
        .select('*')
        .eq('account_id', accountId)
        .order('next_follow_up_at', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false }),
      supabase
        .from('profiles')
        .select('id, full_name')
        .eq('account_id', accountId)
        .order('full_name'),
    ]);

    if (prospectsResult.error) {
      toast.error(t('loadError'));
    } else {
      setProspects((prospectsResult.data ?? []) as ColdProspect[]);
    }
    if (!membersResult.error) setMembers(membersResult.data ?? []);
    setLoading(false);
  }, [accountId, supabase, t]);

  useEffect(() => {
    // The loading transition belongs to this async data fetch. As on the
    // Contacts page, it is intentional on mount/account change rather than
    // derived state that could be calculated during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  const metrics = useMemo(
    () => calculateProspectMetrics(prospects),
    [prospects]
  );
  const memberNames = useMemo(
    () =>
      new Map(
        members.map((member) => [
          member.id,
          member.full_name ?? t('unknownOwner'),
        ])
      ),
    [members, t]
  );

  const filteredProspects = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return prospects.filter((prospect) => {
      const matchesSearch =
        !term ||
        [
          prospect.name,
          prospect.instagram,
          prospect.whatsapp,
          prospect.company,
          prospect.niche,
        ].some((value) => value?.toLocaleLowerCase().includes(term));
      const matchesStatus =
        statusFilter === 'all' || prospect.status === statusFilter;
      const matchesOwner =
        ownerFilter === 'all' ||
        (ownerFilter === 'unassigned'
          ? prospect.assigned_to === null
          : prospect.assigned_to === ownerFilter);
      return matchesSearch && matchesStatus && matchesOwner;
    });
  }, [ownerFilter, prospects, search, statusFilter]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEdit(prospect: ColdProspect) {
    setEditing(prospect);
    setForm({
      name: prospect.name,
      instagram: prospect.instagram ?? '',
      whatsapp: prospect.whatsapp ?? '',
      company: prospect.company ?? '',
      niche: prospect.niche ?? '',
      source: prospect.source ?? '',
      status: prospect.status,
      attempt_count: String(prospect.attempt_count),
      assigned_to: prospect.assigned_to ?? 'unassigned',
      last_contact_at: toDateTimeLocal(prospect.last_contact_at),
      next_follow_up_at: toDateTimeLocal(prospect.next_follow_up_at),
      notes: prospect.notes ?? '',
    });
    setFormOpen(true);
  }

  function updateForm<K extends keyof ProspectFormState>(
    key: K,
    value: ProspectFormState[K]
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function saveProspect() {
    const validation = validateProspectInput(form);
    if (!validation.valid) {
      toast.error(t(`validation.${validation.error}`));
      return;
    }
    if (!accountId || !user) return;

    setSaving(true);
    const payload = {
      account_id: accountId,
      name: form.name.trim(),
      instagram: normalizeInstagram(form.instagram) || null,
      whatsapp: normalizeWhatsApp(form.whatsapp) || null,
      company: form.company.trim() || null,
      niche: form.niche.trim() || null,
      source: form.source.trim() || null,
      status: form.status,
      attempt_count: Math.max(0, Number.parseInt(form.attempt_count, 10) || 0),
      assigned_to: form.assigned_to === 'unassigned' ? null : form.assigned_to,
      last_contact_at: toIsoOrNull(form.last_contact_at),
      next_follow_up_at: toIsoOrNull(form.next_follow_up_at),
      notes: form.notes.trim() || null,
    };

    const result = editing
      ? await supabase
          .from('cold_prospects')
          .update(payload)
          .eq('id', editing.id)
      : await supabase
          .from('cold_prospects')
          .insert({ ...payload, created_by: user.id });

    if (result.error) {
      toast.error(t('saveError'));
    } else {
      toast.success(t(editing ? 'updated' : 'created'));
      setFormOpen(false);
      await fetchData();
    }
    setSaving(false);
  }

  async function registerAttempt(prospect: ColdProspect) {
    const update = buildAttemptUpdate(prospect, new Date().toISOString());
    const { error } = await supabase
      .from('cold_prospects')
      .update(update)
      .eq('id', prospect.id);
    if (error) {
      toast.error(t('attemptError'));
      return;
    }
    toast.success(t('attemptRegistered', { count: update.attempt_count }));
    await fetchData();
  }

  async function updateStatus(
    prospect: ColdProspect,
    status: ColdProspectStatus
  ) {
    const { error } = await supabase
      .from('cold_prospects')
      .update({ status })
      .eq('id', prospect.id);
    if (error) toast.error(t('saveError'));
    else await fetchData();
  }

  async function deleteProspect() {
    if (!deleteTarget) return;
    setSaving(true);
    const { error } = await supabase
      .from('cold_prospects')
      .delete()
      .eq('id', deleteTarget.id);
    if (error) toast.error(t('deleteError'));
    else {
      toast.success(t('deleted'));
      setDeleteTarget(null);
      await fetchData();
    }
    setSaving(false);
  }

  const metricCards = [
    {
      key: 'total',
      value: metrics.total,
      icon: UsersRound,
      tone: 'text-sky-500',
    },
    {
      key: 'contacted',
      value: metrics.contacted,
      icon: PhoneCall,
      tone: 'text-violet-500',
    },
    {
      key: 'replied',
      value: metrics.replied,
      icon: MessageCircle,
      tone: 'text-cyan-500',
    },
    {
      key: 'interested',
      value: metrics.interested,
      icon: Sparkles,
      tone: 'text-emerald-500',
    },
    {
      key: 'responseRate',
      value: `${metrics.responseRate}%`,
      icon: UserRoundCheck,
      tone: 'text-cyan-500',
    },
    {
      key: 'overdue',
      value: metrics.overdue,
      icon: AlertTriangle,
      tone: 'text-amber-500',
    },
  ] as const;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-4 lg:p-6">
      <section className="border-border bg-card relative overflow-hidden rounded-2xl border px-5 py-6 shadow-sm sm:px-7">
        <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-[radial-gradient(circle_at_center,var(--color-primary),transparent_68%)] opacity-10 lg:block" />
        <div className="relative flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div className="max-w-2xl">
            <div className="text-primary mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] uppercase">
              <CircleDot className="size-3.5" />
              {t('eyebrow')}
            </div>
            <h2 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              {t('title')}
            </h2>
            <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-relaxed">
              {t('description')}
            </p>
          </div>
          {canSendMessages && (
            <Button
              size="lg"
              onClick={openCreate}
              className="shadow-primary/15 shadow-lg"
            >
              <Plus /> {t('newProspect')}
            </Button>
          )}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {metricCards.map(({ key, value, icon: Icon, tone }) => (
          <Card key={key} className="relative overflow-hidden">
            <CardContent className="flex items-center justify-between gap-3">
              <div>
                <p className="text-muted-foreground text-xs font-medium">
                  {t(`metrics.${key}`)}
                </p>
                <p className="mt-1 text-2xl font-semibold tracking-tight">
                  {value}
                </p>
              </div>
              <div className={cn('bg-muted rounded-xl p-2.5', tone)}>
                <Icon className="size-5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card className="gap-0 py-0">
        <div className="border-border flex flex-col gap-3 border-b p-4 xl:flex-row xl:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('searchPlaceholder')}
              className="pl-9"
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value ?? 'all')}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allStatuses')}</SelectItem>
                {COLD_PROSPECT_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(`status.${status}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={ownerFilter}
              onValueChange={(value) => setOwnerFilter(value ?? 'all')}
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allOwners')}</SelectItem>
                <SelectItem value="unassigned">{t('unassigned')}</SelectItem>
                {members.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.full_name ?? t('unknownOwner')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('table.prospect')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead>{t('table.attempts')}</TableHead>
                <TableHead>{t('table.owner')}</TableHead>
                <TableHead>{t('table.followUp')}</TableHead>
                <TableHead className="w-24 text-right">
                  {t('table.actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-40 text-center">
                    <Loader2 className="text-primary mx-auto size-5 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : filteredProspects.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-56 text-center">
                    <div className="mx-auto flex max-w-sm flex-col items-center">
                      <div className="bg-muted text-muted-foreground mb-3 rounded-2xl p-3">
                        <UsersRound className="size-6" />
                      </div>
                      <p className="font-medium">{t('emptyTitle')}</p>
                      <p className="text-muted-foreground mt-1 text-sm">
                        {t('emptyDescription')}
                      </p>
                      {canSendMessages && prospects.length === 0 && (
                        <Button
                          variant="outline"
                          className="mt-4"
                          onClick={openCreate}
                        >
                          <Plus /> {t('createFirst')}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredProspects.map((prospect) => {
                  const overdue = isFollowUpOverdue(prospect);
                  return (
                    <TableRow
                      key={prospect.id}
                      className={cn(overdue && 'bg-amber-500/[0.035]')}
                    >
                      <TableCell>
                        <div className="min-w-52">
                          <p className="text-foreground font-medium">
                            {prospect.name}
                          </p>
                          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                            {prospect.instagram && (
                              <a
                                href={`https://instagram.com/${prospect.instagram}`}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:text-primary inline-flex items-center gap-1"
                              >
                                <AtSign className="size-3" />
                                {prospect.instagram}
                              </a>
                            )}
                            {prospect.whatsapp && (
                              <a
                                href={`https://wa.me/${prospect.whatsapp}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 hover:text-emerald-500"
                              >
                                <MessageCircle className="size-3" />+
                                {prospect.whatsapp}
                              </a>
                            )}
                          </div>
                          {(prospect.company || prospect.niche) && (
                            <p className="text-muted-foreground mt-1 text-xs">
                              {[prospect.company, prospect.niche]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={prospect.status}
                          disabled={!canSendMessages}
                          onValueChange={(value) =>
                            value &&
                            void updateStatus(
                              prospect,
                              value as ColdProspectStatus
                            )
                          }
                        >
                          <SelectTrigger
                            className={cn(
                              'h-7 border text-xs',
                              STATUS_STYLES[prospect.status]
                            )}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {COLD_PROSPECT_STATUSES.map((status) => (
                              <SelectItem key={status} value={status}>
                                {t(`status.${status}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="min-w-5 text-center font-semibold">
                            {prospect.attempt_count}
                          </span>
                          {canSendMessages && (
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => void registerAttempt(prospect)}
                              title={t('registerAttempt')}
                            >
                              <PhoneCall /> +1
                            </Button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {prospect.assigned_to
                          ? (memberNames.get(prospect.assigned_to) ??
                            t('unknownOwner'))
                          : t('unassigned')}
                      </TableCell>
                      <TableCell>
                        {prospect.next_follow_up_at ? (
                          <div
                            className={cn(
                              'flex items-center gap-2 text-sm',
                              overdue
                                ? 'font-medium text-amber-600 dark:text-amber-400'
                                : 'text-muted-foreground'
                            )}
                          >
                            {overdue ? (
                              <AlertTriangle className="size-4" />
                            ) : (
                              <CalendarClock className="size-4" />
                            )}
                            {new Intl.DateTimeFormat(undefined, {
                              dateStyle: 'short',
                              timeStyle: 'short',
                            }).format(new Date(prospect.next_follow_up_at))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={<Button variant="ghost" size="icon-sm" />}
                          >
                            <MoreHorizontal />
                            <span className="sr-only">
                              {t('table.actions')}
                            </span>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {prospect.instagram && (
                              <DropdownMenuItem
                                onClick={() =>
                                  window.open(
                                    `https://instagram.com/${prospect.instagram}`,
                                    '_blank',
                                    'noopener,noreferrer'
                                  )
                                }
                              >
                                <AtSign /> {t('openInstagram')}{' '}
                                <ExternalLink className="ml-auto" />
                              </DropdownMenuItem>
                            )}
                            {prospect.whatsapp && (
                              <DropdownMenuItem
                                onClick={() =>
                                  window.open(
                                    `https://wa.me/${prospect.whatsapp}`,
                                    '_blank',
                                    'noopener,noreferrer'
                                  )
                                }
                              >
                                <MessageCircle /> {t('openWhatsApp')}{' '}
                                <ExternalLink className="ml-auto" />
                              </DropdownMenuItem>
                            )}
                            {canSendMessages && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => openEdit(prospect)}
                                >
                                  <Pencil /> {t('edit')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => setDeleteTarget(prospect)}
                                >
                                  <Trash2 /> {t('delete')}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        {!loading && filteredProspects.length > 0 && (
          <div className="border-border text-muted-foreground border-t px-4 py-3 text-xs">
            {t('showing', {
              count: filteredProspects.length,
              total: prospects.length,
            })}
          </div>
        )}
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t(editing ? 'editTitle' : 'createTitle')}
            </DialogTitle>
            <DialogDescription>{t('formDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-1 sm:grid-cols-2">
            <FormField label={t('fields.name')} required>
              <Input
                value={form.name}
                onChange={(event) => updateForm('name', event.target.value)}
                placeholder={t('placeholders.name')}
              />
            </FormField>
            <FormField label={t('fields.status')}>
              <Select
                value={form.status}
                onValueChange={(value) =>
                  value && updateForm('status', value as ColdProspectStatus)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COLD_PROSPECT_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {t(`status.${status}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t('fields.instagram')} hint={t('channelHint')}>
              <div className="relative">
                <AtSign className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  value={form.instagram}
                  onChange={(event) =>
                    updateForm('instagram', event.target.value)
                  }
                  placeholder="@usuario"
                  className="pl-9"
                />
              </div>
            </FormField>
            <FormField label={t('fields.whatsapp')} hint={t('channelHint')}>
              <div className="relative">
                <MessageCircle className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  value={form.whatsapp}
                  onChange={(event) =>
                    updateForm('whatsapp', event.target.value)
                  }
                  placeholder="+55 11 99999-9999"
                  className="pl-9"
                  inputMode="tel"
                />
              </div>
            </FormField>
            <FormField label={t('fields.company')}>
              <Input
                value={form.company}
                onChange={(event) => updateForm('company', event.target.value)}
                placeholder={t('placeholders.company')}
              />
            </FormField>
            <FormField label={t('fields.niche')}>
              <Input
                value={form.niche}
                onChange={(event) => updateForm('niche', event.target.value)}
                placeholder={t('placeholders.niche')}
              />
            </FormField>
            <FormField label={t('fields.source')}>
              <Input
                value={form.source}
                onChange={(event) => updateForm('source', event.target.value)}
                placeholder={t('placeholders.source')}
              />
            </FormField>
            <FormField label={t('fields.owner')}>
              <Select
                value={form.assigned_to}
                onValueChange={(value) =>
                  updateForm('assigned_to', value ?? 'unassigned')
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">{t('unassigned')}</SelectItem>
                  {members.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.full_name ?? t('unknownOwner')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t('fields.attempts')}>
              <Input
                type="number"
                min="0"
                value={form.attempt_count}
                onChange={(event) =>
                  updateForm('attempt_count', event.target.value)
                }
              />
            </FormField>
            <FormField label={t('fields.lastContact')}>
              <Input
                type="datetime-local"
                value={form.last_contact_at}
                onChange={(event) =>
                  updateForm('last_contact_at', event.target.value)
                }
              />
            </FormField>
            <FormField label={t('fields.nextFollowUp')}>
              <Input
                type="datetime-local"
                value={form.next_follow_up_at}
                onChange={(event) =>
                  updateForm('next_follow_up_at', event.target.value)
                }
              />
            </FormField>
            <FormField label={t('fields.notes')} className="sm:col-span-2">
              <Textarea
                value={form.notes}
                onChange={(event) => updateForm('notes', event.target.value)}
                placeholder={t('placeholders.notes')}
                rows={4}
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void saveProspect()} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Check />}
              {t(editing ? 'saveChanges' : 'saveProspect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteDescription', { name: deleteTarget?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void deleteProspect()}
              disabled={saving}
            >
              {saving ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t('confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FormField({
  label,
  hint,
  required = false,
  className,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {children}
      {hint && <p className="text-muted-foreground text-[11px]">{hint}</p>}
    </div>
  );
}
