import { redirect } from 'next/navigation'

import { getCurrentAccount } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { loadAdPlatformCredential } from '@/lib/ads/credentials'
import { supabaseAdmin } from '@/lib/automations/admin-client'

import { AdsMonitorClient, type MonitorView } from './ads-monitor-client'

export const dynamic = 'force-dynamic'

/**
 * Monitoramento das contas de anúncio.
 *
 * Os dados iniciais são lidos aqui, no servidor, com o cliente do
 * usuário: a RLS já limita tudo à conta dele e a tela abre preenchida
 * em vez de piscar vazia. As alterações vão pelas rotas de
 * `/api/ads/*`, que refazem a checagem de papel.
 */
export default async function AdsMonitorPage() {
  const { supabase, accountId, role } = await getCurrentAccount()

  // A tela toda é de administração da conta; quem não pode alterar
  // também não deve ver o estado da credencial.
  if (!hasMinRole(role, 'admin')) redirect('/dashboard')

  const [{ data: monitors }, { data: contacts }] = await Promise.all([
    supabase
      .from('ad_account_monitors')
      .select('*')
      .order('created_at', { ascending: true }),
    supabase
      .from('contacts')
      .select('id, name, phone')
      .order('name', { ascending: true })
      .limit(500),
  ])

  const rows = monitors ?? []
  const { data: states } = rows.length
    ? await supabase
        .from('ad_account_monitor_state')
        .select('*')
        .in(
          'monitor_id',
          rows.map((row) => row.id as string),
        )
    : { data: [] }

  const stateByMonitor = new Map<string, Record<string, unknown>>()
  for (const state of states ?? []) {
    stateByMonitor.set(String(state.monitor_id), state)
  }

  // O service role lê a credencial porque o segredo mora numa tabela
  // sem policy; só os metadados atravessam para o componente.
  const credential = await loadAdPlatformCredential(supabaseAdmin(), accountId)

  const views: MonitorView[] = rows.map((row) => ({
    id: String(row.id),
    externalAccountId: String(row.external_account_id),
    displayName: (row.display_name as string | null) ?? null,
    contactId: (row.contact_id as string | null) ?? null,
    thresholdCents: Number(row.low_balance_threshold_cents ?? 0),
    currency: (row.currency as string | null) ?? 'BRL',
    enabled: row.enabled === true,
    notifyClient: row.notify_client === true,
    notifyInternal: row.notify_internal === true,
    cooldownHours: Number(row.cooldown_hours ?? 24),
    state: (() => {
      const state = stateByMonitor.get(String(row.id))
      if (!state) return null
      return {
        checkedAt: (state.checked_at as string | null) ?? null,
        availableCents:
          typeof state.available_cents === 'number'
            ? state.available_cents
            : null,
        accountStatus:
          typeof state.account_status === 'number' ? state.account_status : null,
        lowBalanceActive: state.low_balance_active === true,
        paymentIssueActive: state.payment_issue_active === true,
        paymentIssueCode: (state.payment_issue_code as string | null) ?? null,
        lastError: (state.last_error as string | null) ?? null,
      }
    })(),
  }))

  return (
    <AdsMonitorClient
      monitors={views}
      contacts={(contacts ?? []).map((contact) => ({
        id: String(contact.id),
        name: (contact.name as string | null) ?? null,
        phone: (contact.phone as string | null) ?? null,
      }))}
      credential={credential}
    />
  )
}
