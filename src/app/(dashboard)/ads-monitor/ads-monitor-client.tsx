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
  label: string | null
  businessId: string | null
  internalNotifyPhone: string | null
  lastVerifiedAt: string | null
  lastVerifyError: string | null
}

interface Props {
  monitors: MonitorView[]
  contacts: ContactOption[]
  credential: CredentialView | null
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

export function AdsMonitorClient({ monitors, contacts, credential }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function call(
    url: string,
    init: RequestInit,
    successMessage: string,
  ): Promise<boolean> {
    setError(null)
    setNotice(null)
    const response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      setError(typeof body.error === 'string' ? body.error : 'Não foi possível concluir.')
      return false
    }
    setNotice(successMessage)
    startTransition(() => router.refresh())
    return true
  }

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

      <CredentialCard credential={credential} onSubmit={call} pending={pending} />

      <NewMonitorCard
        contacts={contacts}
        onSubmit={call}
        pending={pending}
        disabled={credential === null}
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
              onSubmit={call}
              pending={pending}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

type Submit = (
  url: string,
  init: RequestInit,
  successMessage: string,
) => Promise<boolean>

function CredentialCard({
  credential,
  onSubmit,
  pending,
}: {
  credential: CredentialView | null
  onSubmit: Submit
  pending: boolean
}) {
  const [token, setToken] = useState('')
  const [phone, setPhone] = useState(credential?.internalNotifyPhone ?? '')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Acesso à Meta</CardTitle>
        <CardDescription>
          Token de usuário de sistema do seu Business Manager, com permissão
          de leitura de anúncios. Ele é guardado criptografado e nunca volta
          para esta tela.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ads-token">
            Token {credential ? '(deixe em branco para manter o atual)' : ''}
          </Label>
          <Input
            id="ads-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="EAAG..."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ads-internal-phone">Número interno da cópia</Label>
          <Input
            id="ads-internal-phone"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+5511999999999"
          />
        </div>

        {credential?.lastVerifiedAt ? (
          <p className="text-muted-foreground text-xs">
            Última validação:{' '}
            {new Date(credential.lastVerifiedAt).toLocaleString('pt-BR')}
          </p>
        ) : null}
        {credential?.lastVerifyError ? (
          <p className="text-destructive text-xs">{credential.lastVerifyError}</p>
        ) : null}

        <div>
          <Button
            disabled={pending}
            onClick={async () => {
              const ok = await onSubmit(
                '/api/ads/credentials',
                {
                  method: 'PUT',
                  body: JSON.stringify({
                    access_token: token,
                    internal_notify_phone: phone,
                  }),
                },
                'Acesso salvo.',
              )
              if (ok) setToken('')
            }}
          >
            Salvar acesso
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function NewMonitorCard({
  contacts,
  onSubmit,
  pending,
  disabled,
}: {
  contacts: ContactOption[]
  onSubmit: Submit
  pending: boolean
  disabled: boolean
}) {
  const [adAccountId, setAdAccountId] = useState('')
  const [contactId, setContactId] = useState('')
  const [threshold, setThreshold] = useState('100')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Adicionar conta</CardTitle>
        <CardDescription>
          {disabled
            ? 'Salve o acesso à Meta antes de cadastrar contas.'
            : 'Informe a conta de anúncio e o cliente que recebe o aviso.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ads-account-id">Conta de anúncio</Label>
          <Input
            id="ads-account-id"
            value={adAccountId}
            onChange={(event) => setAdAccountId(event.target.value)}
            placeholder="act_1234567890"
          />
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
          <Label htmlFor="ads-threshold">Avisar quando o saldo ficar abaixo de</Label>
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
  onSubmit,
  pending,
}: {
  monitor: MonitorView
  contacts: ContactOption[]
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
            {money(monitor.thresholdCents, monitor.currency)}
          </p>
        </div>
        <div className="text-right text-sm">
          {state?.availableCents !== null && state !== null ? (
            <p
              className={
                state.lowBalanceActive ? 'text-destructive font-medium' : ''
              }
            >
              {money(state.availableCents as number, monitor.currency)}
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
        <div className="flex min-w-48 flex-col gap-1">
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
