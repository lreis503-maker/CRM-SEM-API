'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Tela do monitoramento de contas de anúncio.
 *
 * Usa só `Button`, `Input`, `Label` e `Card` da biblioteca do projeto,
 * mais controles nativos para seleção e caixas de marcação. É uma
 * escolha consciente: esses quatro têm API estável, e trocar os
 * nativos pelos equivalentes do design system é um ajuste visual que
 * não muda comportamento nenhum.
 */

export interface MonitorState {
  checkedAt: string | null
  availableCents: number | null
  accountStatus: number | null
  lowBalanceActive: boolean
  paymentIssueActive: boolean
  paymentIssueCode: string | null
  lastError: string | null
}

export interface MonitorView {
  id: string
  credentialId: string | null
  externalAccountId: string
  displayName: string | null
  contactId: string | null
  thresholdCents: number
  currency: string
  enabled: boolean
  notifyClient: boolean
  notifyInternal: boolean
  cooldownHours: number
  state: MonitorState | null
}

export interface ContactOption {
  id: string
  name: string | null
  phone: string | null
}

export interface CredentialView {
  id: string
  label: string
  businessId: string | null
  internalNotifyPhone: string | null
  lastVerifiedAt: string | null
  lastVerifyError: string | null
}

interface MetaAdAccountOption {
  externalAccountId: string
  name: string | null
  currency: string | null
}

interface Props {
  monitors: MonitorView[]
  contacts: ContactOption[]
  credentials: CredentialView[]
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: currency || 'BRL',
    }).format(cents / 100)
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`
  }
}

function contactLabel(contact: ContactOption): string {
  return contact.name?.trim() || contact.phone || contact.id
}

const SELECT_CLASS =
  'border-input bg-background h-8 w-full rounded-md border px-2 text-sm'

type Submit = (
  url: string,
  init: RequestInit,
  successMessage: string,
) => Promise<boolean>

export function AdsMonitorClient({ monitors, contacts, credentials }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const call: Submit = async (url, init, successMessage) => {
    setError(null)
    setNotice(null)
    const response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      setError(
        typeof body.error === 'string' ? body.error : 'Não foi possível concluir.',
      )
      return false
    }
    setNotice(successMessage)
    startTransition(() => router.refresh())
    return true
  }

  const byCredential = new Map(credentials.map((c) => [c.id, c]))

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold">Monitoramento de contas de anúncio</h1>
        <p className="text-muted-foreground text-sm">
          Avisa o cliente no WhatsApp quando o saldo fica abaixo do limite ou
          quando a cobrança para.
        </p>
      </div>

      {error ? (
        <p className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="bg-muted text-muted-foreground rounded-md border p-3 text-sm">
          {notice}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Portfólios conectados</CardTitle>
          <CardDescription>
            Cada portfólio empresarial da Meta tem o seu próprio token de
            usuário de sistema — o usuário de um portfólio não enxerga as
            contas do outro. O número interno da cópia também é por portfólio.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {credentials.map((credential) => (
            <PortfolioRow
              key={credential.id}
              credential={credential}
              onSubmit={call}
              pending={pending}
            />
          ))}
          <AddPortfolioForm onSubmit={call} pending={pending} />
        </CardContent>
      </Card>

      <NewMonitorCard
        contacts={contacts}
        credentials={credentials}
        onSubmit={call}
        pending={pending}
      />

      <Card>
        <CardHeader>
          <CardTitle>Contas monitoradas</CardTitle>
          <CardDescription>
            {monitors.length === 0
              ? 'Nenhuma conta cadastrada ainda.'
              : `${monitors.length} conta(s) sendo verificadas.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {monitors.map((monitor) => (
            <MonitorRow
              key={monitor.id}
              monitor={monitor}
              contacts={contacts}
              credentials={credentials}
              credentialLabel={
                monitor.credentialId
                  ? (byCredential.get(monitor.credentialId)?.label ?? null)
                  : null
              }
              onSubmit={call}
              pending={pending}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function PortfolioRow({
  credential,
  onSubmit,
  pending,
}: {
  credential: CredentialView
  onSubmit: Submit
  pending: boolean
}) {
  const [label, setLabel] = useState(credential.label)
  const [phone, setPhone] = useState(credential.internalNotifyPhone ?? '')
  const [token, setToken] = useState('')

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`label-${credential.id}`}>Nome do portfólio</Label>
          <Input
            id={`label-${credential.id}`}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`phone-${credential.id}`}>Número interno da cópia</Label>
          <Input
            id={`phone-${credential.id}`}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+5511999999999"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`token-${credential.id}`}>
          Trocar token (deixe em branco para manter o atual)
        </Label>
        <Input
          id={`token-${credential.id}`}
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="EAAG..."
        />
      </div>

      {credential.lastVerifiedAt ? (
        <p className="text-muted-foreground text-xs">
          Última validação:{' '}
          {new Date(credential.lastVerifiedAt).toLocaleString('pt-BR')}
        </p>
      ) : null}
      {credential.lastVerifyError ? (
        <p className="text-destructive text-xs">{credential.lastVerifyError}</p>
      ) : null}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={async () => {
            const ok = await onSubmit(
              `/api/ads/credentials/${credential.id}`,
              {
                method: 'PATCH',
                body: JSON.stringify({
                  label,
                  internal_notify_phone: phone,
                  access_token: token,
                }),
              },
              'Portfólio atualizado.',
            )
            if (ok) setToken('')
          }}
        >
          Salvar
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() =>
            onSubmit(
              `/api/ads/credentials/${credential.id}`,
              { method: 'DELETE' },
              'Portfólio desconectado.',
            )
          }
        >
          Desconectar
        </Button>
      </div>
    </div>
  )
}

function AddPortfolioForm({
  onSubmit,
  pending,
}: {
  onSubmit: Submit
  pending: boolean
}) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [phone, setPhone] = useState('')

  if (!open) {
    return (
      <div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Conectar outro portfólio
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-portfolio-label">Nome do portfólio</Label>
        <Input
          id="new-portfolio-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Agência — clientes A"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-portfolio-token">Token de usuário de sistema</Label>
        <Input
          id="new-portfolio-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="EAAG..."
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-portfolio-phone">Número interno da cópia</Label>
        <Input
          id="new-portfolio-phone"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="+5511999999999"
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={async () => {
            const ok = await onSubmit(
              '/api/ads/credentials',
              {
                method: 'POST',
                body: JSON.stringify({
                  label,
                  access_token: token,
                  internal_notify_phone: phone,
                }),
              },
              'Portfólio conectado.',
            )
            if (ok) {
              setLabel('')
              setToken('')
              setPhone('')
              setOpen(false)
            }
          }}
        >
          Conectar
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

function NewMonitorCard({
  contacts,
  credentials,
  onSubmit,
  pending,
}: {
  contacts: ContactOption[]
  credentials: CredentialView[]
  onSubmit: Submit
  pending: boolean
}) {
  const [credentialId, setCredentialId] = useState('')
  const [adAccountId, setAdAccountId] = useState('')
  const [contactId, setContactId] = useState('')
  const [threshold, setThreshold] = useState('100')
  const [options, setOptions] = useState<MetaAdAccountOption[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const disabled = credentials.length === 0

  async function loadAccounts(id: string) {
    setLoading(true)
    setListError(null)
    setOptions(null)
    try {
      const response = await fetch(`/api/ads/credentials/${id}/ad-accounts`)
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setListError(
          typeof body.error === 'string'
            ? body.error
            : 'Não foi possível listar as contas.',
        )
        return
      }
      setOptions(body.ad_accounts ?? [])
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Adicionar conta de anúncio</CardTitle>
        <CardDescription>
          {disabled
            ? 'Conecte um portfólio antes de cadastrar contas.'
            : 'Escolha o portfólio, a conta e o cliente que recebe o aviso.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ads-credential">Portfólio</Label>
          <select
            id="ads-credential"
            className={SELECT_CLASS}
            value={credentialId}
            onChange={(event) => {
              setCredentialId(event.target.value)
              setOptions(null)
              setAdAccountId('')
              if (event.target.value) void loadAccounts(event.target.value)
            }}
          >
            <option value="">Selecione…</option>
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ads-account-id">Conta de anúncio</Label>
          {loading ? (
            <p className="text-muted-foreground text-sm">Buscando contas…</p>
          ) : null}
          {options && options.length > 0 ? (
            <select
              id="ads-account-id"
              className={SELECT_CLASS}
              value={adAccountId}
              onChange={(event) => setAdAccountId(event.target.value)}
            >
              <option value="">Selecione…</option>
              {options.map((option) => (
                <option
                  key={option.externalAccountId}
                  value={option.externalAccountId}
                >
                  {option.name ?? `act_${option.externalAccountId}`} ·{' '}
                  {option.externalAccountId}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id="ads-account-id"
              value={adAccountId}
              onChange={(event) => setAdAccountId(event.target.value)}
              placeholder="act_1234567890"
            />
          )}
          {listError ? (
            <p className="text-muted-foreground text-xs">
              {listError} Você ainda pode informar o identificador na mão.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ads-contact">Cliente avisado</Label>
          <select
            id="ads-contact"
            className={SELECT_CLASS}
            value={contactId}
            onChange={(event) => setContactId(event.target.value)}
          >
            <option value="">Só cópia interna</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contactLabel(contact)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ads-threshold">
            Avisar quando o saldo ficar abaixo de
          </Label>
          <Input
            id="ads-threshold"
            inputMode="decimal"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            placeholder="100"
          />
        </div>

        <div>
          <Button
            disabled={pending || disabled}
            onClick={async () => {
              // O banco guarda centavos; a tela fala em reais.
              const parsed = Number(threshold.replace(',', '.'))
              if (!Number.isFinite(parsed) || parsed < 0) return
              const ok = await onSubmit(
                '/api/ads/accounts',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    credential_id: credentialId || null,
                    external_account_id: adAccountId,
                    contact_id: contactId || null,
                    low_balance_threshold_cents: Math.round(parsed * 100),
                  }),
                },
                'Conta adicionada. A primeira verificação traz o saldo.',
              )
              if (ok) {
                setAdAccountId('')
                setContactId('')
              }
            }}
          >
            Adicionar
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function MonitorRow({
  monitor,
  contacts,
  credentials,
  credentialLabel,
  onSubmit,
  pending,
}: {
  monitor: MonitorView
  contacts: ContactOption[]
  credentials: CredentialView[]
  credentialLabel: string | null
  onSubmit: Submit
  pending: boolean
}) {
  const state = monitor.state

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">
            {monitor.displayName ?? `act_${monitor.externalAccountId}`}
          </p>
          <p className="text-muted-foreground text-xs">
            act_{monitor.externalAccountId} · limite{' '}
            {money(monitor.thresholdCents, monitor.currency)} ·{' '}
            {credentialLabel ?? 'sem portfólio'}
          </p>
        </div>
        <div className="text-right text-sm">
          {state !== null && state.availableCents !== null ? (
            <p
              className={
                state.lowBalanceActive ? 'text-destructive font-medium' : ''
              }
            >
              {money(state.availableCents, monitor.currency)}
            </p>
          ) : (
            <p className="text-muted-foreground">sem leitura</p>
          )}
          {state?.checkedAt ? (
            <p className="text-muted-foreground text-xs">
              {new Date(state.checkedAt).toLocaleString('pt-BR')}
            </p>
          ) : null}
        </div>
      </div>

      {state?.paymentIssueActive ? (
        <p className="text-destructive text-sm">
          Cobrança parada: {state.paymentIssueCode}
        </p>
      ) : null}
      {state?.lastError ? (
        <p className="text-muted-foreground text-xs">{state.lastError}</p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-40 flex-col gap-1">
          <Label htmlFor={`cred-${monitor.id}`} className="text-xs">
            Portfólio
          </Label>
          <select
            id={`cred-${monitor.id}`}
            className={SELECT_CLASS}
            defaultValue={monitor.credentialId ?? ''}
            onChange={(event) =>
              onSubmit(
                `/api/ads/accounts/${monitor.id}`,
                {
                  method: 'PATCH',
                  body: JSON.stringify({ credential_id: event.target.value }),
                },
                'Portfólio atualizado.',
              )
            }
          >
            <option value="">Selecione…</option>
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex min-w-40 flex-col gap-1">
          <Label htmlFor={`contact-${monitor.id}`} className="text-xs">
            Cliente avisado
          </Label>
          <select
            id={`contact-${monitor.id}`}
            className={SELECT_CLASS}
            defaultValue={monitor.contactId ?? ''}
            onChange={(event) =>
              onSubmit(
                `/api/ads/accounts/${monitor.id}`,
                {
                  method: 'PATCH',
                  body: JSON.stringify({ contact_id: event.target.value || null }),
                },
                'Contato atualizado.',
              )
            }
          >
            <option value="">Só cópia interna</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contactLabel(contact)}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            defaultChecked={monitor.enabled}
            onChange={(event) =>
              onSubmit(
                `/api/ads/accounts/${monitor.id}`,
                {
                  method: 'PATCH',
                  body: JSON.stringify({ enabled: event.target.checked }),
                },
                'Monitoramento atualizado.',
              )
            }
          />
          Ativo
        </label>

        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              onSubmit(
                '/api/ads/monitor/run',
                {
                  method: 'POST',
                  body: JSON.stringify({ monitor_id: monitor.id }),
                },
                'Verificação executada.',
              )
            }
          >
            Verificar agora
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() =>
              onSubmit(
                `/api/ads/accounts/${monitor.id}`,
                { method: 'DELETE' },
                'Conta removida.',
              )
            }
          >
            Remover
          </Button>
        </div>
      </div>
    </div>
  )
}
