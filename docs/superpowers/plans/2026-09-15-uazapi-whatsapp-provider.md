# Suporte UAZAPI ao WhatsApp - Plano de Implementacao

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que cada conta escolha entre a API oficial da Meta e a UAZAPI, conecte a UAZAPI por QR Code e use texto/midia no CRM sem alterar o funcionamento atual da Meta.

**Architecture:** A configuracao continua sendo uma por conta, mas passa a informar qual provedor esta ativo. Um adaptador pequeno escolhe Meta ou UAZAPI para texto e midia; recursos exclusivos da Meta ficam protegidos por uma matriz de capacidades no servidor e na interface. Os dois webhooks convertem suas cargas para um formato interno comum antes de atualizar contatos, conversas e mensagens.

**Tech Stack:** Next.js 16.3.5 App Router, React 19.2.4, TypeScript 6, Supabase/PostgreSQL, Vitest 4, next-intl, Tailwind CSS 4 e componentes Base UI existentes.

**Spec:** `docs/superpowers/specs/2026-09-15-uazapi-whatsapp-provider-design.md`

## Global Constraints

- Manter exatamente uma configuracao WhatsApp ativa por `account_id`.
- Linhas existentes de `whatsapp_config` e `messages` devem migrar para `provider = 'meta'` sem intervencao do usuario.
- `UAZAPI_ADMIN_TOKEN` e tokens de instancia nunca podem chegar ao navegador, respostas HTTP ou logs.
- A UAZAPI v1 suporta somente conversas individuais com texto, imagem, video, audio e documento.
- Modelos/templates, sincronizacao, disparos, interativos, reacoes e localizacao continuam exclusivos da Meta nesta entrega.
- O webhook UAZAPI aceita somente segredo de rota valido, limita o corpo, ignora grupos/mensagens proprias e coloca formatos desconhecidos em quarentena sanitizada por sete dias.
- Nao repetir automaticamente um envio UAZAPI cujo resultado ficou ambiguo apos timeout ou queda de conexao.
- Enquanto as capacidades carregam, controles dependentes do provedor ficam desativados para impedir cliques durante a hidratacao.
- Antes de alterar rotas ou componentes Next.js, ler `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`, `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` e `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`.
- Nao adicionar biblioteca de QR Code: a UAZAPI ja devolve a imagem em base64 e a interface apenas a exibe.
- Nao declarar a integracao validada ao vivo enquanto nao houver uma instancia UAZAPI real para o smoke test.
- Antes de cada commit, executar `git status --short` e adicionar somente os arquivos daquela tarefa; nunca incluir alteracoes preexistentes do usuario.

---

## Como Ler Este Plano

Cada tarefa abaixo termina em um ponto que pode ser testado e salvo no Git. Em linguagem simples, a ordem sera:

1. preparar o banco sem mudar a Meta;
2. ensinar o CRM a reconhecer os recursos de cada provedor;
3. desativar primeiro Modelos, sincronizacao e Disparos quando necessario;
4. criar a comunicacao segura com a UAZAPI;
5. construir a conexao e o QR Code;
6. enviar texto e midia pelo provedor escolhido;
7. adaptar automacoes e fluxos;
8. separar o processamento comum do webhook Meta;
9. receber mensagens UAZAPI com protecoes e diagnostico;
10. revisar tudo e deixar documentado como ativar.

---

### Task 1: Fundacao do banco e tipos do provedor

**Em termos simples:** adicionar os novos campos com valores padrao que preservam integralmente as contas Meta existentes.

**Files:**

- Create: `supabase/migrations/043_uazapi_provider.sql`
- Create: `src/lib/whatsapp/providers/types.ts`
- Create: `src/lib/whatsapp/providers/capabilities.ts`
- Test: `src/lib/whatsapp/providers/capabilities.test.ts`
- Modify: `src/types/index.ts`

**Interfaces:**

- Produces: `WhatsAppProvider`, `WhatsAppConnectionStatus`, `WhatsAppCapability`, `WhatsAppCapabilitySnapshot`, `PROVIDER_CAPABILITIES`, `supportsCapability()` e `assertProviderCapability()`.
- Consumes: os enums de status e conteudo ja definidos em `src/types/index.ts`.

- [ ] **Step 1: Escrever o teste que descreve a matriz de capacidades**

```ts
import { describe, expect, it } from 'vitest';
import {
  ProviderNotSupportedError,
  assertProviderCapability,
  supportsCapability,
} from './capabilities';

describe('WhatsApp provider capabilities', () => {
  it('keeps Meta templates and broadcasts enabled', () => {
    expect(supportsCapability('meta', 'templates')).toBe(true);
    expect(supportsCapability('meta', 'broadcasts')).toBe(true);
  });

  it('allows only the UAZAPI v1 core', () => {
    expect(supportsCapability('uazapi', 'send_text')).toBe(true);
    expect(supportsCapability('uazapi', 'send_media')).toBe(true);
    expect(supportsCapability('uazapi', 'templates')).toBe(false);
    expect(supportsCapability('uazapi', 'interactive')).toBe(false);
  });

  it('throws a stable error for an unsupported operation', () => {
    expect(() => assertProviderCapability('uazapi', 'broadcasts')).toThrow(
      ProviderNotSupportedError
    );
  });
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha esperada**

Run: `npm test -- src/lib/whatsapp/providers/capabilities.test.ts`

Expected: FAIL porque `types.ts` e `capabilities.ts` ainda nao existem.

- [ ] **Step 3: Criar os tipos e a matriz imutavel**

```ts
export type WhatsAppProvider = 'meta' | 'uazapi';

export type WhatsAppConnectionStatus =
  | 'not_configured'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'hibernated'
  | 'error';

export type WhatsAppCapability =
  | 'connection_status'
  | 'send_text'
  | 'send_media'
  | 'receive_text_media'
  | 'meta_service_window'
  | 'templates'
  | 'template_sync'
  | 'broadcasts'
  | 'interactive'
  | 'reactions'
  | 'location';

export interface WhatsAppCapabilitySnapshot {
  provider: WhatsAppProvider;
  status: WhatsAppConnectionStatus;
  connected: boolean;
  uazapiAvailable: boolean;
  capabilities: Record<WhatsAppCapability, boolean>;
}
```

`PROVIDER_CAPABILITIES` deve marcar texto/midia/recebimento como `true` para ambos, `meta_service_window` e todos os recursos avancados como `true` apenas para Meta, e nunca mutar em runtime. `ProviderNotSupportedError` deve expor `provider`, `capability`, `code = 'provider_not_supported'` e `status = 409`.

- [ ] **Step 4: Criar a migracao aditiva**

Usar estes blocos como contrato da migracao:

```sql
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_webhook_secret_hash TEXT,
  ADD COLUMN IF NOT EXISTS connection_attempt_id UUID,
  ADD COLUMN IF NOT EXISTS connected_phone TEXT,
  ADD COLUMN IF NOT EXISTS connected_name TEXT,
  ADD COLUMN IF NOT EXISTS connected_avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS last_connection_error TEXT,
  ADD COLUMN IF NOT EXISTS connection_checked_at TIMESTAMPTZ;

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;
ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('disconnected', 'connecting', 'connected', 'hibernated', 'error'));

ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'uazapi'));

ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_provider_fields_check
  CHECK (
    (provider = 'meta'
      AND phone_number_id IS NOT NULL
      AND access_token IS NOT NULL
      AND uazapi_instance_id IS NULL
      AND uazapi_instance_name IS NULL
      AND uazapi_instance_token IS NULL
      AND uazapi_webhook_secret_hash IS NULL
      AND connection_attempt_id IS NULL)
    OR
    (provider = 'uazapi'
      AND phone_number_id IS NULL
      AND waba_id IS NULL
      AND access_token IS NULL
      AND verify_token IS NULL
      AND uazapi_instance_id IS NOT NULL
      AND uazapi_instance_token IS NOT NULL
      AND uazapi_webhook_secret_hash IS NOT NULL
      AND connection_attempt_id IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_instance
  ON whatsapp_config(uazapi_instance_id)
  WHERE uazapi_instance_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_uazapi_webhook_hash
  ON whatsapp_config(uazapi_webhook_secret_hash)
  WHERE uazapi_webhook_secret_hash IS NOT NULL;
```

Na mesma migracao:

- criar `whatsapp_contact_identities` com FKs para `accounts` e `contacts`, unicidade `(account_id, provider, external_id)` e RLS sem politica de navegador;
- adicionar `messages.provider TEXT NOT NULL DEFAULT 'meta'` com `CHECK` Meta/UAZAPI;
- substituir `idx_messages_conversation_message_id` por unicidade `(conversation_id, provider, message_id)`;
- ampliar `broadcasts.status` com `cancelled` e adicionar `cancellation_reason TEXT`;
- criar `whatsapp_webhook_quarantine` com fingerprint unico por conta/provedor/motivo, payload `JSONB`, contagem, timestamps e `expires_at`.

- [ ] **Step 5: Atualizar os tipos publicos do CRM**

`WhatsAppConfig` deve usar campos Meta opcionais, incluir os campos UAZAPI sem expor tokens em objetos enviados ao cliente, e `Message` deve incluir `provider: WhatsAppProvider`. `BroadcastStatus` deve incluir `cancelled`.

- [ ] **Step 6: Executar testes e validar o SQL**

Run: `npm test -- src/lib/whatsapp/providers/capabilities.test.ts`

Expected: PASS.

Run: `npx supabase db lint`

Expected: nenhuma falha SQL. Se o ambiente local Supabase estiver disponivel, executar `npx supabase db reset` e confirmar que as 43 migracoes terminam sem erro.

- [ ] **Step 7: Criar o checkpoint Git**

```bash
git add supabase/migrations/043_uazapi_provider.sql src/types/index.ts src/lib/whatsapp/providers
git commit -m "feat: add WhatsApp provider data model"
```

---

### Task 2: Leitura central de capacidades

**Em termos simples:** criar uma unica resposta que diga a toda a tela qual provedor esta ativo e o que ele permite.

**Files:**

- Create: `src/lib/whatsapp/providers/account-capabilities.ts`
- Test: `src/lib/whatsapp/providers/account-capabilities.test.ts`
- Create: `src/app/api/whatsapp/capabilities/route.ts`
- Test: `src/app/api/whatsapp/capabilities/route.test.ts`
- Create: `src/hooks/use-whatsapp-capabilities.tsx`
- Modify: `src/app/(dashboard)/dashboard-shell.tsx`

**Interfaces:**

- Consumes: `WhatsAppCapabilitySnapshot` e `PROVIDER_CAPABILITIES` da Task 1.
- Produces: `loadAccountCapabilitySnapshot(db, accountId, env)`, `WhatsAppCapabilitiesProvider`, `useWhatsAppCapabilities()` e `refreshCapabilities()`.

- [ ] **Step 1: Escrever testes para conta Meta, UAZAPI e sem configuracao**

```ts
it('defaults an account without configuration to Meta product behavior', async () => {
  const result = await loadAccountCapabilitySnapshot(
    dbWithConfig(null),
    'acc-1',
    {}
  );
  expect(result.provider).toBe('meta');
  expect(result.status).toBe('not_configured');
  expect(result.capabilities.templates).toBe(true);
});

it('returns UAZAPI restrictions and installation availability', async () => {
  const result = await loadAccountCapabilitySnapshot(
    dbWithConfig({ provider: 'uazapi', status: 'connected' }),
    'acc-1',
    {
      UAZAPI_ENABLED: 'true',
      UAZAPI_BASE_URL: 'https://tenant.uazapi.com',
      UAZAPI_ADMIN_TOKEN: 'secret',
      NEXT_PUBLIC_SITE_URL: 'https://crm.example.com',
    }
  );
  expect(result.connected).toBe(true);
  expect(result.capabilities.broadcasts).toBe(false);
  expect(result.uazapiAvailable).toBe(true);
});
```

- [ ] **Step 2: Executar os testes e observar a falha**

Run: `npm test -- src/lib/whatsapp/providers/account-capabilities.test.ts src/app/api/whatsapp/capabilities/route.test.ts`

Expected: FAIL por modulos ausentes.

- [ ] **Step 3: Implementar a leitura account-scoped e a disponibilidade por ambiente**

`loadAccountCapabilitySnapshot()` deve selecionar somente `provider,status` por `account_id`. Validar `UAZAPI_BASE_URL` com `new URL()`, exigir protocolo `https:`, caminho `/`, ausencia de usuario/senha e as quatro variaveis globais. A resposta nunca inclui nomes de variaveis faltantes nem valores secretos.

- [ ] **Step 4: Implementar a rota autenticada**

```ts
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const snapshot = await loadAccountCapabilitySnapshot(
      supabase,
      accountId,
      process.env
    );
    return NextResponse.json(snapshot);
  } catch (error) {
    return toErrorResponse(error);
  }
}
```

- [ ] **Step 5: Criar o contexto React com estado fechado durante o carregamento**

O provider deve buscar `/api/whatsapp/capabilities` uma vez depois da autenticacao, expor `loading`, `snapshot`, `supports(capability)` e `refreshCapabilities()`. Durante `loading`, `supports()` retorna `false` para qualquer acao dependente do provedor.

- [ ] **Step 6: Envolver o dashboard no novo provider**

Em `DashboardShell`, colocar `WhatsAppCapabilitiesProvider` dentro de `AuthProvider` e ao redor de `DashboardShellInner`, mantendo `PresenceHeartbeat`, notificacoes e redirecionamento atuais inalterados.

- [ ] **Step 7: Rodar testes e verificacao de tipos**

Run: `npm test -- src/lib/whatsapp/providers/account-capabilities.test.ts src/app/api/whatsapp/capabilities/route.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Criar o checkpoint Git**

```bash
git add src/lib/whatsapp/providers src/app/api/whatsapp/capabilities src/hooks/use-whatsapp-capabilities.tsx 'src/app/(dashboard)/dashboard-shell.tsx'
git commit -m "feat: expose WhatsApp provider capabilities"
```

---

### Task 3: Desativar Modelos, sincronizacao e Disparos no layout

**Em termos simples:** cumprir primeiro o bloqueio pedido pelo usuario, deixando as opcoes visiveis, explicadas e impossiveis de clicar quando UAZAPI estiver ativa.

**Files:**

- Create: `src/components/whatsapp/provider-disabled-control.tsx`
- Create: `src/components/whatsapp/provider-page-guard.tsx`
- Create: `src/lib/whatsapp/providers/ui-policy.ts`
- Test: `src/lib/whatsapp/providers/ui-policy.test.ts`
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `src/components/dashboard/quick-actions.tsx`
- Modify: `src/components/settings/settings-rail.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`
- Modify: `src/app/(dashboard)/broadcasts/page.tsx`
- Modify: `src/app/(dashboard)/broadcasts/new/page.tsx`
- Modify: `src/app/(dashboard)/broadcasts/[id]/page.tsx`
- Modify: `src/components/settings/template-manager.tsx`
- Modify: `src/components/inbox/message-composer.tsx`
- Modify: `src/components/automations/automation-builder.tsx`
- Modify: `src/components/flows/forms/node-config-form.tsx`
- Modify: `src/components/flows/flow-canvas.tsx`
- Modify: `messages/pt.json`
- Modify: `messages/en.json`
- Modify: `messages/es.json`
- Modify: `messages/ko.json`

**Interfaces:**

- Consumes: `useWhatsAppCapabilities()` da Task 2.
- Produces: `providerDisabledReason(snapshot, capability, t)` e o componente reutilizavel `ProviderDisabledControl`.

- [ ] **Step 1: Testar a politica visual pura**

```ts
it('explains why a Meta-only action is disabled under UAZAPI', () => {
  expect(providerDisabledReason(uazapiSnapshot, 'templates')).toBe(
    'Disponivel somente com a API oficial da Meta'
  );
});

it('does not disable a supported UAZAPI action', () => {
  expect(providerDisabledReason(uazapiSnapshot, 'send_text')).toBeNull();
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha**

Run: `npm test -- src/lib/whatsapp/providers/ui-policy.test.ts`

Expected: FAIL porque `ui-policy.ts` nao existe.

- [ ] **Step 3: Implementar controle desativado acessivel**

`ProviderDisabledControl` deve usar os componentes existentes de `src/components/ui/tooltip.tsx`, manter um gatilho focalizavel com `aria-disabled="true"`, aplicar cursor e opacidade de indisponibilidade, e nunca executar `onClick` nem navegar.

- [ ] **Step 4: Bloquear Disparos no menu e atalhos**

Adicionar `requires?: WhatsAppCapability` a `NavItem`; marcar `/broadcasts` com `requires: 'broadcasts'`. Quando bloqueado, renderizar o mesmo conteudo visual sem `Link`. Em `QuickActions`, aplicar a mesma regra a `/broadcasts/new`.

Envolver as tres paginas de Disparos em `ProviderPageGuard`. Sob UAZAPI, o guard nao monta a pagina e redireciona para `/settings?tab=whatsapp&reason=provider_not_supported`; a secao WhatsApp mostra o aviso traduzido. Assim, um favorito ou URL digitada tambem nao abre Disparos.

- [ ] **Step 5: Bloquear Modelos e sincronizacao nas Configuracoes**

Adicionar `disabledSections` a `SettingsRail`; para `templates`, nao chamar `onSelect`. Se uma URL abrir `?tab=templates` diretamente sob UAZAPI, renderizar uma faixa informativa sem montar `TemplateManager`. Dentro de `TemplateManager`, manter o botao de sincronizacao desativado como protecao adicional durante mudancas de estado.

- [ ] **Step 6: Bloquear templates e interativos no compositor**

Calcular:

```ts
const effectiveSessionExpired =
  supports('meta_service_window') && sessionExpired;
const templatesEnabled = supports('templates');
const interactiveEnabled = supports('interactive');
```

Usar `effectiveSessionExpired` para texto/midia, desativar o botao de modelo sem abrir `TemplatePicker`, e desativar apenas a opcao interativa do menu `+`; respostas rapidas de texto continuam ativas.

- [ ] **Step 7: Bloquear a criacao de passos incompatíveis**

No construtor de automacoes, deixar `send_template` visivel e desativado sob UAZAPI. Nos fluxos, desativar `send_buttons` e `send_list`, preservando texto, coleta de texto e midia. Definicoes historicas continuam renderizadas, mas com aviso de incompatibilidade e sem permitir ativacao.

- [ ] **Step 8: Adicionar traducoes nos quatro idiomas**

Criar as chaves `provider.metaOnly`, `provider.uazapiUnavailable`, `provider.unsupportedPage` e os textos de conexao UAZAPI dentro dos namespaces ja usados por Sidebar, Settings, Inbox, Automations e Flows. O texto em portugues de `provider.metaOnly` deve ser exatamente `Disponivel somente com a API oficial da Meta`.

- [ ] **Step 9: Rodar teste, tipos e lint dos arquivos alterados**

Run: `npm test -- src/lib/whatsapp/providers/ui-policy.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run lint -- src/components/layout/sidebar.tsx src/components/dashboard/quick-actions.tsx src/components/settings src/components/inbox/message-composer.tsx src/components/automations/automation-builder.tsx src/components/flows`

Expected: PASS.

- [ ] **Step 10: Criar o checkpoint Git**

```bash
git add -- src/components/whatsapp/provider-disabled-control.tsx src/components/whatsapp/provider-page-guard.tsx src/lib/whatsapp/providers/ui-policy.ts src/lib/whatsapp/providers/ui-policy.test.ts src/components/layout/sidebar.tsx src/components/dashboard/quick-actions.tsx src/components/settings/settings-rail.tsx 'src/app/(dashboard)/settings/page.tsx' 'src/app/(dashboard)/broadcasts/page.tsx' 'src/app/(dashboard)/broadcasts/new/page.tsx' 'src/app/(dashboard)/broadcasts/[id]/page.tsx' src/components/settings/template-manager.tsx src/components/inbox/message-composer.tsx src/components/automations/automation-builder.tsx src/components/flows/forms/node-config-form.tsx src/components/flows/flow-canvas.tsx messages/pt.json messages/en.json messages/es.json messages/ko.json
git commit -m "feat: disable Meta-only WhatsApp controls"
```

---

### Task 4: Protecao equivalente no servidor

**Em termos simples:** impedir que alguem contorne os botoes desativados digitando uma URL ou chamando a API diretamente.

**Files:**

- Create: `src/lib/whatsapp/providers/account-capability-guard.ts`
- Test: `src/lib/whatsapp/providers/account-capability-guard.test.ts`
- Modify: `src/app/api/whatsapp/templates/sync/route.ts`
- Modify: `src/app/api/whatsapp/templates/submit/route.ts`
- Modify: `src/app/api/whatsapp/templates/[id]/route.ts`
- Modify: `src/app/api/whatsapp/broadcast/route.ts`
- Modify: `src/app/api/whatsapp/broadcast/[id]/resume/route.ts`
- Modify: `src/app/api/v1/broadcasts/route.ts`
- Modify: `src/app/api/v1/broadcasts/[id]/route.ts`
- Modify: `src/app/api/whatsapp/react/route.ts`
- Modify: `src/app/api/automations/route.ts`
- Modify: `src/app/api/automations/[id]/route.ts`
- Modify: `src/app/api/flows/[id]/route.ts`
- Modify: `src/app/api/flows/[id]/activate/route.ts`

**Interfaces:**

- Consumes: `ProviderNotSupportedError` e `loadAccountCapabilitySnapshot()`.
- Produces: `requireAccountCapability(db, accountId, capability)` e `providerCapabilityErrorResponse(error)`.

- [ ] **Step 1: Escrever testes do erro HTTP estavel**

```ts
it('returns the stable 409 provider contract', async () => {
  await expect(
    requireAccountCapability(uazapiDb, 'acc-1', 'templates')
  ).rejects.toMatchObject({
    code: 'provider_not_supported',
    provider: 'uazapi',
    capability: 'templates',
    status: 409,
  });
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha**

Run: `npm test -- src/lib/whatsapp/providers/account-capability-guard.test.ts`

Expected: FAIL por modulo ausente.

- [ ] **Step 3: Implementar o guard e o mapeamento de resposta**

```ts
return NextResponse.json(
  {
    error: 'provider_not_supported',
    provider: error.provider,
    capability: error.capability,
  },
  { status: 409 }
);
```

- [ ] **Step 4: Aplicar o guard antes de efeitos colaterais Meta**

As rotas de template exigem `templates` ou `template_sync`; criacao/retomada de disparo e API publica exigem `broadcasts`; reacao exige `reactions`. O guard deve rodar depois de autenticacao/account resolution e antes de buscar token, criar destinatarios, alterar filas ou chamar Meta.

- [ ] **Step 5: Validar definicoes de automacao e fluxo**

Quando o provedor for UAZAPI, POST/PATCH de automacao que contenha `step_type = 'send_template'` retorna 409. PUT/ativacao de fluxo que contenha `send_buttons` ou `send_list` retorna 409. A leitura e a exclusao das definicoes continuam permitidas para que o usuario preserve ou remova seu historico.

- [ ] **Step 6: Adicionar testes de rota focados**

Adicionar um caso UAZAPI e um caso Meta nos testes das rotas tocadas. O caso UAZAPI confirma 409 e nenhuma chamada ao transporte; o caso Meta confirma que o comportamento anterior segue alcancavel.

- [ ] **Step 7: Executar a bateria focada**

Run: `npm test -- src/lib/whatsapp/providers/account-capability-guard.test.ts src/lib/whatsapp/broadcast-core.test.ts src/lib/whatsapp/broadcast-resume.test.ts src/lib/automations/validate.test.ts src/lib/flows/validate.test.ts`

Expected: PASS.

- [ ] **Step 8: Criar o checkpoint Git**

```bash
git add -- src/lib/whatsapp/providers/account-capability-guard.ts src/lib/whatsapp/providers/account-capability-guard.test.ts src/app/api/whatsapp/templates/sync/route.ts src/app/api/whatsapp/templates/submit/route.ts 'src/app/api/whatsapp/templates/[id]/route.ts' src/app/api/whatsapp/broadcast/route.ts 'src/app/api/whatsapp/broadcast/[id]/resume/route.ts' src/app/api/v1/broadcasts/route.ts 'src/app/api/v1/broadcasts/[id]/route.ts' src/app/api/whatsapp/react/route.ts src/app/api/automations/route.ts 'src/app/api/automations/[id]/route.ts' 'src/app/api/flows/[id]/route.ts' 'src/app/api/flows/[id]/activate/route.ts'
git commit -m "feat: guard Meta-only operations by provider"
```

---

### Task 5: Cliente HTTP seguro da UAZAPI

**Em termos simples:** criar uma unica porta de comunicacao com a UAZAPI, com timeout, validacao e sigilos removidos dos erros.

**Files:**

- Create: `src/lib/whatsapp/providers/uazapi-client.ts`
- Test: `src/lib/whatsapp/providers/uazapi-client.test.ts`
- Create: `src/lib/whatsapp/providers/uazapi-errors.ts`
- Test: `src/lib/whatsapp/providers/uazapi-errors.test.ts`

**Interfaces:**

- Produces: `createUazapiAdminClient()`, `createUazapiInstanceClient(token)`, `UazapiClientError`, `UazapiInstance`, `UazapiSendResult` e metodos de lifecycle/mensagem.
- Consumes: `UAZAPI_BASE_URL`, `UAZAPI_ADMIN_TOKEN` e `fetch` do runtime Node.

- [ ] **Step 1: Escrever testes de cabecalho, URL, timeout e redacao**

```ts
it('uses admintoken only when creating an instance', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(jsonResponse({ id: 'i-1', token: 't-1' }));
  const client = createUazapiAdminClient({
    baseUrl: 'https://tenant.uazapi.com',
    adminToken: 'admin-secret',
    fetch,
  });
  await client.createInstance({ name: 'wacrm-acc-1-a1b2' });
  expect(fetch).toHaveBeenCalledWith(
    'https://tenant.uazapi.com/instance/create',
    expect.objectContaining({
      headers: expect.objectContaining({ admintoken: 'admin-secret' }),
    })
  );
});

it('never includes tokens or QR data in an error message', async () => {
  const error = sanitizeUazapiError({
    token: 'secret',
    qrcode: 'base64-secret',
    error: 'bad',
  });
  expect(JSON.stringify(error)).not.toContain('secret');
});
```

- [ ] **Step 2: Executar os testes e confirmar a falha**

Run: `npm test -- src/lib/whatsapp/providers/uazapi-client.test.ts src/lib/whatsapp/providers/uazapi-errors.test.ts`

Expected: FAIL por modulos ausentes.

- [ ] **Step 3: Implementar o request helper**

O helper deve aceitar `fetchImpl`, usar `AbortSignal.timeout(15_000)`, enviar `Accept` e `Content-Type: application/json`, limitar resposta JSON a 1 MiB, e validar que o corpo e um objeto/array antes de acessar campos. Nunca concatenar tokens em mensagens de erro.

- [ ] **Step 4: Implementar os metodos documentados**

```ts
interface UazapiInstanceClient {
  configureWebhook(input: UazapiWebhookConfig): Promise<void>;
  connect(): Promise<UazapiInstance>;
  getStatus(): Promise<UazapiInstance>;
  disconnect(): Promise<void>;
  deleteInstance(): Promise<void>;
  sendText(input: UazapiTextInput): Promise<UazapiSendResult>;
  sendMedia(input: UazapiMediaInput): Promise<UazapiSendResult>;
  downloadMessage(id: string): Promise<UazapiDownloadedMedia>;
}
```

Mapear para `POST /webhook`, `POST /instance/connect`, `GET /instance/status`, `POST /instance/disconnect`, `DELETE /instance`, `POST /send/text`, `POST /send/media` e `POST /message/download`.

- [ ] **Step 5: Implementar erros tipados**

Mapear 401/403 para `authentication`, 404 para `not_found`, 409 para `conflict`, 429 para `rate_limited`, 5xx/timeout/rede para `upstream_unavailable`. Marcar somente leitura de status e reconciliacao de lifecycle como seguras para retry; metodos de envio fazem uma unica tentativa.

- [ ] **Step 6: Executar os testes**

Run: `npm test -- src/lib/whatsapp/providers/uazapi-client.test.ts src/lib/whatsapp/providers/uazapi-errors.test.ts`

Expected: PASS, incluindo teste que confirma uma unica chamada de `fetch` em timeout de envio.

- [ ] **Step 7: Criar o checkpoint Git**

```bash
git add src/lib/whatsapp/providers/uazapi-client.ts src/lib/whatsapp/providers/uazapi-client.test.ts src/lib/whatsapp/providers/uazapi-errors.ts src/lib/whatsapp/providers/uazapi-errors.test.ts
git commit -m "feat: add secure UAZAPI client"
```

---

### Task 6: Ciclo de instancia, troca de provedor e rotas do QR

**Em termos simples:** criar, acompanhar, reconectar e remover uma instancia sem deixar tokens ou instancias abandonadas.

**Files:**

- Create: `src/lib/whatsapp/providers/uazapi-instance.ts`
- Test: `src/lib/whatsapp/providers/uazapi-instance.test.ts`
- Create: `src/lib/whatsapp/providers/provider-switch.ts`
- Test: `src/lib/whatsapp/providers/provider-switch.test.ts`
- Create: `supabase/migrations/044_uazapi_provider_switch.sql`
- Create: `src/app/api/whatsapp/uazapi/connect/route.ts`
- Test: `src/app/api/whatsapp/uazapi/connect/route.test.ts`
- Create: `src/app/api/whatsapp/uazapi/status/route.ts`
- Test: `src/app/api/whatsapp/uazapi/status/route.test.ts`
- Modify: `src/app/api/whatsapp/config/route.ts`
- Modify: `src/app/api/whatsapp/config/verify-registration/route.ts`

**Interfaces:**

- Consumes: cliente UAZAPI da Task 5, criptografia existente, guard/capacidades e schema da Task 1.
- Produces: `beginUazapiConnection()`, `refreshUazapiConnection()`, `removeUazapiConnection()`, `prepareProviderSwitch()` e resposta publica `UazapiConnectionView`.

- [ ] **Step 1: Testar segredo, QR e compensacao**

```ts
it('stores only the webhook hash and encrypted instance token', async () => {
  const result = await beginUazapiConnection(ctx);
  expect(result.publicView).not.toHaveProperty('instanceToken');
  expect(ctx.savedConfig.uazapi_webhook_secret_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(ctx.savedConfig.uazapi_instance_token).not.toBe(
    'plain-instance-token'
  );
});

it('deletes the remote instance when webhook setup fails', async () => {
  ctx.instance.configureWebhook.mockRejectedValue(new Error('upstream'));
  await expect(beginUazapiConnection(ctx)).rejects.toThrow();
  expect(ctx.instance.deleteInstance).toHaveBeenCalledOnce();
  expect(ctx.replaceConfig).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Executar os testes e confirmar a falha**

Run: `npm test -- src/lib/whatsapp/providers/uazapi-instance.test.ts src/lib/whatsapp/providers/provider-switch.test.ts`

Expected: FAIL por servicos ausentes.

- [ ] **Step 3: Implementar inicio idempotente da conexao**

Gerar segredo com `randomBytes(32).toString('base64url')`, armazenar `sha256(secret)`, construir o callback somente a partir de `NEXT_PUBLIC_SITE_URL` validado e configurar:

```ts
{
  enabled: true,
  url: `${siteUrl}/api/whatsapp/webhook/uazapi/${secret}`,
  events: ['messages', 'messages_update', 'connection'],
  excludeMessages: ['wasSentByApi', 'fromMeYes', 'isGroupYes'],
  addUrlEvents: false,
  addUrlTypesMessages: false,
}
```

Se ja houver uma configuracao UAZAPI `connecting`, reutilizar a instancia. Criar outra somente quando a instancia anterior estiver confirmadamente ausente.

- [ ] **Step 4: Implementar transacao de troca e trabalho incompatível**

Na troca Meta -> UAZAPI, depois de criar webhook e antes do QR:

- atualizar `broadcasts` em `scheduled` ou `sending` para `cancelled`, motivo `provider_switched`;
- desativar automacoes da conta que tenham passo `send_template`;
- mover para `draft` fluxos ativos com `send_buttons` ou `send_list`;
- marcar execucoes ativas desses fluxos como `failed`, `end_reason = 'provider_switched'` e `ended_at = now()`;
- substituir a unica linha `whatsapp_config` por UAZAPI `connecting`.

Executar essas alteracoes pela funcao SQL/RPC `switch_account_to_uazapi` criada em `044_uazapi_provider_switch.sql`. A RPC recebe apenas ids e valores ja criptografados, nunca o segredo puro do webhook. Manter a migracao 043 imutavel depois do checkpoint da Task 1.

- [ ] **Step 5: Implementar status, renovacao e exclusao**

`refreshUazapiConnection()` valida `connection_attempt_id`, consulta `/instance/status`, traduz `disconnected|connecting|connected|hibernated` e persiste perfil/erro sem QR. Gerar novo QR chama `/instance/connect` na mesma instancia e troca `connection_attempt_id`. Exclusao chama disconnect e depois DELETE; 404 conta como sucesso.

- [ ] **Step 6: Integrar troca UAZAPI -> Meta sem perder recuperacao**

No POST Meta existente: validar token/ids primeiro; se a configuracao atual for UAZAPI, desconectar sem deletar; registrar e inscrever a Meta; se a Meta falhar, manter a linha UAZAPI como `disconnected`; se funcionar, deletar a instancia e substituir a linha por Meta. GET e verificacao Meta devem filtrar `provider = 'meta'` antes de descriptografar `access_token`.

O GET de configuracao deve retornar apenas provedor, status e dados publicos de perfil. O DELETE deve despachar por provedor: manter a exclusao local atual para Meta e usar `removeUazapiConnection()` para UAZAPI.

- [ ] **Step 7: Criar rotas account-scoped**

POST `/api/whatsapp/uazapi/connect` aceita `{ action: 'start' | 'refresh_qr' }`; GET `/api/whatsapp/uazapi/status?attempt=<uuid>` consulta status. Mutacoes exigem `requireRole('admin')`; status exige `viewer`. Respostas retornam somente:

```ts
interface UazapiConnectionView {
  provider: 'uazapi';
  status: WhatsAppConnectionStatus;
  attemptId: string;
  qrCodeDataUrl: string | null;
  qrExpiresAt: string | null;
  connectedPhone: string | null;
  connectedName: string | null;
  connectedAvatarUrl: string | null;
  error: string | null;
}
```

- [ ] **Step 8: Rodar testes de servico e rota**

Run: `npm test -- src/lib/whatsapp/providers/uazapi-instance.test.ts src/lib/whatsapp/providers/provider-switch.test.ts src/app/api/whatsapp/uazapi/connect/route.test.ts src/app/api/whatsapp/uazapi/status/route.test.ts src/app/api/whatsapp/config/verify-registration/route.test.ts`

Expected: PASS.

- [ ] **Step 9: Criar o checkpoint Git**

```bash
git add -- supabase/migrations/044_uazapi_provider_switch.sql src/lib/whatsapp/providers/uazapi-instance.ts src/lib/whatsapp/providers/uazapi-instance.test.ts src/lib/whatsapp/providers/provider-switch.ts src/lib/whatsapp/providers/provider-switch.test.ts src/app/api/whatsapp/uazapi/connect/route.ts src/app/api/whatsapp/uazapi/connect/route.test.ts src/app/api/whatsapp/uazapi/status/route.ts src/app/api/whatsapp/uazapi/status/route.test.ts src/app/api/whatsapp/config/route.ts src/app/api/whatsapp/config/verify-registration/route.ts
git commit -m "feat: add UAZAPI connection lifecycle"
```

---

### Task 7: Tela de Configuracoes e QR Code

**Em termos simples:** permitir escolher o provedor, confirmar a troca, escanear o QR e entender claramente o estado da conexao.

**Files:**

- Create: `src/components/settings/whatsapp/provider-selector.tsx`
- Create: `src/components/settings/whatsapp/meta-connection-panel.tsx`
- Create: `src/components/settings/whatsapp/uazapi-connection-panel.tsx`
- Create: `src/components/settings/whatsapp/uazapi-view-state.ts`
- Test: `src/components/settings/whatsapp/uazapi-view-state.test.ts`
- Modify: `src/components/settings/whatsapp-config.tsx`
- Modify: `messages/pt.json`
- Modify: `messages/en.json`
- Modify: `messages/es.json`
- Modify: `messages/ko.json`

**Interfaces:**

- Consumes: `UazapiConnectionView` da Task 6 e `refreshCapabilities()` da Task 2.
- Produces: seletor Meta/UAZAPI e painel de estados `not_configured`, `connecting`, `connected`, `hibernated`, `disconnected` e `error`.

- [ ] **Step 1: Escrever testes do estado visual puro**

```ts
it('shows a new QR action after expiry', () => {
  expect(
    deriveUazapiViewState(
      { status: 'connecting', qrExpiresAt: '2026-09-15T12:00:00Z' },
      new Date('2026-09-15T12:02:01Z')
    )
  ).toMatchObject({ showQr: false, primaryAction: 'refresh_qr' });
});

it('stops polling when connected', () => {
  expect(deriveUazapiViewState({ status: 'connected' }, new Date()).poll).toBe(
    false
  );
});
```

- [ ] **Step 2: Executar o teste e confirmar a falha**

Run: `npm test -- src/components/settings/whatsapp/uazapi-view-state.test.ts`

Expected: FAIL por modulo ausente.

- [ ] **Step 3: Dividir o componente atual sem mudar a tela Meta**

Mover o formulario e diagnostico Meta de `whatsapp-config.tsx` para `meta-connection-panel.tsx` preservando props, chamadas e textos. O arquivo pai passa a carregar configuracao sanitizada, controlar o provedor selecionado e renderizar um dos dois paineis.

- [ ] **Step 4: Implementar o seletor e confirmacao destrutiva**

Usar controle segmentado com Meta e UAZAPI. Ao trocar, abrir dialogo informando que credenciais/sessao do provedor atual serao removidas, mas contatos, conversas e mensagens permanecem. Mostrar a quantidade de disparos cancelados e automacoes/fluxos desativados retornada pelo servidor.

- [ ] **Step 5: Implementar o painel QR**

Exibir QR em `<img>` com dimensao estavel entre 240 e 320 px, fundo branco, alt traduzido e sem salvar a URL. Poll a cada 3 segundos, abortar fetch anterior ao desmontar/ocultar pagina e parar em dois minutos. Em reload com `connecting`, retomar status da mesma tentativa.

- [ ] **Step 6: Implementar estados e acoes**

- `connecting`: QR, contagem de validade e cancelar/remover;
- `connected`: telefone/nome/avatar disponiveis, atualizar status e desconectar;
- `hibernated`: informar pausa e oferecer reconectar/status;
- `disconnected`: gerar novo QR ou remover;
- `error`: mensagem curta, tentar novamente na mesma instancia ou remover.

Depois de conexao, remocao ou troca, chamar `refreshCapabilities()` para atualizar imediatamente o restante do layout.

- [ ] **Step 7: Completar as traducoes**

Adicionar textos equivalentes nos quatro arquivos de idioma. Nenhum texto deve orientar o usuario a manipular token UAZAPI; apenas o operador da instalacao ve aviso generico quando a UAZAPI nao esta configurada no servidor.

- [ ] **Step 8: Rodar testes, tipos e lint**

Run: `npm test -- src/components/settings/whatsapp/uazapi-view-state.test.ts`

Expected: PASS.

Run: `npm run typecheck && npm run lint`

Expected: PASS.

- [ ] **Step 9: Criar o checkpoint Git**

```bash
git add src/components/settings/whatsapp src/components/settings/whatsapp-config.tsx messages
git commit -m "feat: add UAZAPI QR connection settings"
```

---

### Task 8: Envio comum de texto e midia

**Em termos simples:** fazer Inbox e API enviarem pelo provedor escolhido, mantendo templates e interativos somente na Meta.

**Files:**

- Create: `src/lib/whatsapp/providers/send-provider-message.ts`
- Test: `src/lib/whatsapp/providers/send-provider-message.test.ts`
- Create: `src/lib/whatsapp/providers/meta-provider.ts`
- Test: `src/lib/whatsapp/providers/meta-provider.test.ts`
- Create: `src/lib/whatsapp/providers/uazapi-provider.ts`
- Test: `src/lib/whatsapp/providers/uazapi-provider.test.ts`
- Create: `src/lib/whatsapp/providers/resolve-send-target.ts`
- Test: `src/lib/whatsapp/providers/resolve-send-target.test.ts`
- Modify: `src/lib/whatsapp/send-message.ts`
- Modify: `src/lib/whatsapp/send-message.test.ts`
- Modify: `src/app/api/whatsapp/send/route.ts`
- Modify: `src/app/api/v1/messages/route.ts`

**Interfaces:**

- Consumes: config/provider da Task 1, cliente da Task 5 e guard da Task 4.
- Produces: `sendProviderMessage(db, accountId, contact, input)` com resultado comum.

- [ ] **Step 1: Definir testes do contrato de transporte**

```ts
export type ProviderMessageInput =
  | { kind: 'text'; text: string; replyToExternalId?: string; trackId: string }
  | {
      kind: 'media';
      mediaKind: 'image' | 'video' | 'audio' | 'document';
      url: string;
      caption?: string;
      filename?: string;
      replyToExternalId?: string;
      trackId: string;
    };

export interface ProviderSendResult {
  provider: WhatsAppProvider;
  externalMessageId: string;
  status: 'sent';
}
```

Testar que Meta continua usando `phone_number_id/access_token`, UAZAPI usa token da instancia e `/send/text|media`, e template sob UAZAPI falha antes de qualquer fetch.

- [ ] **Step 2: Executar os testes e confirmar a falha**

Run: `npm test -- src/lib/whatsapp/providers/send-provider-message.test.ts src/lib/whatsapp/providers/meta-provider.test.ts src/lib/whatsapp/providers/uazapi-provider.test.ts src/lib/whatsapp/providers/resolve-send-target.test.ts`

Expected: FAIL por adaptadores ausentes.

- [ ] **Step 3: Implementar resolucao de destino por provedor**

Meta continua usando `resolveContactSendTarget()` e suas variantes de telefone. UAZAPI prefere telefone E.164; sem telefone, consulta `whatsapp_contact_identities` por `contact_id`, `account_id`, `provider = 'uazapi'` e usa o LID completo. Sem destino valido, retornar `SendMessageError('bad_request', ..., 400)`.

- [ ] **Step 4: Implementar os dois adaptadores**

Meta deve apenas envolver funcoes existentes, sem mudar payloads nem retry de variante. UAZAPI mapeia audio para `ptt`, documento com `docName`, legenda em `text`, resposta em `replyid`, e inclui `track_source = 'wacrm'`, `track_id = localMessageId`. Nenhum retry automatico de envio.

- [ ] **Step 5: Refatorar o core de envio**

Em `sendMessageToConversation()`:

1. carregar config e provedor;
2. gerar o UUID local antes da chamada para usa-lo como `track_id`;
3. resolver `reply_to_message_id` dentro da mesma conversa;
4. para texto/midia, delegar a `sendProviderMessage()`;
5. para template/interativo, exigir capacidade e manter o caminho Meta atual;
6. exigir `status = 'connected'` antes de chamar qualquer transporte;
7. inserir `messages.id`, `messages.provider` e o id externo retornado;
8. manter atualizacao da conversa e pausa de fluxo causada por resposta humana.

- [ ] **Step 6: Adaptar as duas rotas existentes**

As rotas continuam com o mesmo JSON de sucesso. `ProviderNotSupportedError` vira 409 no endpoint interno e no envelope da API v1; erros UAZAPI sanitizados nunca devolvem token ou resposta bruta.

- [ ] **Step 7: Executar regressao Meta e novos testes UAZAPI**

Run: `npm test -- src/lib/whatsapp/send-message.test.ts src/app/api/whatsapp/send/route.test.ts src/lib/whatsapp/providers`

Expected: PASS, incluindo os casos Meta anteriores sem alteracao de chamadas.

- [ ] **Step 8: Criar o checkpoint Git**

```bash
git add src/lib/whatsapp/providers src/lib/whatsapp/send-message.ts src/lib/whatsapp/send-message.test.ts src/app/api/whatsapp/send src/app/api/v1/messages
git commit -m "feat: send messages through selected provider"
```

---

### Task 9: Automacoes, fluxos e IA usando o provedor ativo

**Em termos simples:** permitir que respostas automaticas de texto/midia usem UAZAPI, sem deixar uma etapa Meta incompatível executar por engano.

**Files:**

- Modify: `src/lib/automations/meta-send.ts`
- Modify: `src/lib/automations/engine.ts`
- Modify: `src/lib/automations/engine.test.ts`
- Modify: `src/lib/flows/meta-send.ts`
- Modify: `src/lib/flows/engine.ts`
- Modify: `src/lib/flows/engine.test.ts`
- Modify: `src/lib/flows/dispatch.test.ts`
- Modify: `src/lib/ai/auto-reply.ts`

**Interfaces:**

- Consumes: `sendProviderMessage()` da Task 8 e guards da Task 4.
- Produces: `engineSendText()` e `engineSendMedia()` independentes de provedor; funcoes Meta de template/interativo permanecem protegidas.

- [ ] **Step 1: Adicionar testes UAZAPI aos engines**

```ts
it('sends an automation text through UAZAPI and stores provider', async () => {
  providerSend.mockResolvedValue({
    provider: 'uazapi',
    externalMessageId: 'uaz-msg-1',
    status: 'sent',
  });
  await engineSendText(baseArgs);
  expect(insertedMessage).toMatchObject({
    provider: 'uazapi',
    message_id: 'uaz-msg-1',
    sender_type: 'bot',
  });
});

it('refuses a template automation under UAZAPI', async () => {
  await expect(engineSendTemplate(templateArgs)).rejects.toMatchObject({
    code: 'provider_not_supported',
  });
});
```

- [ ] **Step 2: Executar os testes e observar a falha**

Run: `npm test -- src/lib/automations/engine.test.ts src/lib/flows/engine.test.ts`

Expected: FAIL porque os senders ainda carregam credenciais Meta diretamente.

- [ ] **Step 3: Tornar texto e midia independentes do provedor**

Preservar as assinaturas publicas usadas pelos engines. Trocar apenas a parte de credencial/transporte por `sendProviderMessage()`, inserir `provider` na mensagem e manter `sender_type = 'bot'`, `ai_generated`, atualizacao da conversa e retorno `{ whatsapp_message_id }`.

- [ ] **Step 4: Manter template e interativo explicitamente Meta**

`engineSendTemplate()` exige `templates`. `engineSendInteractive()` e os nos `send_buttons/send_list` exigem `interactive`. O erro deve alimentar o log do engine como falha legivel, sem tentar Meta com um token UAZAPI.

- [ ] **Step 5: Confirmar IA de texto**

`dispatchInboundToAiReply()` ja usa o sender de texto dos fluxos. Adicionar um teste que injeta configuracao UAZAPI e confirma uma chamada a `sendProviderMessage()` sem indicador de digitacao Meta. Indicador de digitacao continua opcional e Meta-only.

- [ ] **Step 6: Rodar os testes de engines**

Run: `npm test -- src/lib/automations src/lib/flows src/lib/ai`

Expected: PASS.

- [ ] **Step 7: Criar o checkpoint Git**

```bash
git add -- src/lib/automations/meta-send.ts src/lib/automations/engine.ts src/lib/automations/engine.test.ts src/lib/flows/meta-send.ts src/lib/flows/engine.ts src/lib/flows/engine.test.ts src/lib/flows/dispatch.test.ts src/lib/ai/auto-reply.ts
git commit -m "feat: route automated messages by provider"
```

---

### Task 10: Extrair o processamento comum do webhook Meta

**Em termos simples:** separar o que pertence a Meta do que pertence ao CRM antes de ligar o novo webhook, reduzindo o risco de quebrar mensagens atuais.

**Files:**

- Create: `src/lib/whatsapp/inbound/types.ts`
- Create: `src/lib/whatsapp/inbound/process-inbound-message.ts`
- Test: `src/lib/whatsapp/inbound/process-inbound-message.test.ts`
- Create: `src/lib/whatsapp/inbound/process-status-update.ts`
- Test: `src/lib/whatsapp/inbound/process-status-update.test.ts`
- Create: `src/lib/whatsapp/inbound/meta-normalizer.ts`
- Test: `src/lib/whatsapp/inbound/meta-normalizer.test.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`
- Modify: `src/app/api/whatsapp/webhook/route.test.ts`

**Interfaces:**

- Produces: unioes `NormalizedInboundEvent`, `NormalizedInboundMessage`, `NormalizedStatusUpdate`, `NormalizedConnectionUpdate`, `processInboundMessage()` e `processStatusUpdate()`.
- Consumes: dedupe de contatos, conversas, mirror de midia, automacoes, fluxos, IA e webhooks publicos existentes.

- [ ] **Step 1: Definir o envelope normalizado em testes**

```ts
export interface NormalizedInboundMessage {
  kind: 'message';
  provider: WhatsAppProvider;
  externalMessageId: string;
  occurredAt: string;
  fromMe: boolean;
  isGroup: boolean;
  sender: {
    phone: string;
    externalId: string | null;
    externalIdKind: 'bsuid' | 'lid' | 'jid' | null;
    parentExternalId: string | null;
    displayName: string;
    username: string | null;
  };
  content:
    | { type: 'text'; text: string }
    | {
        type: 'image' | 'video' | 'audio' | 'document';
        text: string | null;
        media: NormalizedMedia;
      }
    | { type: 'location'; text: string }
    | { type: 'interactive'; text: string; replyId: string };
  replyToExternalId: string | null;
}

export interface NormalizedMedia {
  externalMediaId: string;
  locator: 'provider_id' | 'provider_url';
  locatorValue: string;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
}

export interface NormalizedStatusUpdate {
  kind: 'status';
  provider: WhatsAppProvider;
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  occurredAt: string;
  failure: {
    code: string | null;
    title: string | null;
    details: string | null;
  } | null;
}

export interface NormalizedConnectionUpdate {
  kind: 'connection';
  provider: WhatsAppProvider;
  status: Exclude<WhatsAppConnectionStatus, 'not_configured'>;
  occurredAt: string;
  phone: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export class TransientInboundError extends Error {}
```

Os testes Meta devem cobrir telefone, BSUID-only, texto, cada midia atual, resposta, interativo, localizacao, reacao mantida no caminho Meta e status failed com detalhes.

- [ ] **Step 2: Rodar toda a suite atual do webhook antes da extracao**

Run: `npm test -- src/app/api/whatsapp/webhook/route.test.ts src/lib/whatsapp/mirror-inbound-media.test.ts src/lib/whatsapp/wa-identity.test.ts`

Expected: PASS. Registrar a contagem de testes para comparar depois.

- [ ] **Step 3: Implementar o normalizador Meta sem alterar a rota**

Converter `WhatsAppMessage` e `contacts[]` no envelope comum. Manter template lifecycle e reacoes em funcoes Meta especificas, pois UAZAPI v1 nao as usa.

- [ ] **Step 4: Extrair processamento de mensagem e status**

Mover contato/conversa, idempotencia, insercao, unread, dispatch de flow/automation/IA/notificacao/webhook publico e status monotono para os novos modulos. Todas as queries de id externo devem incluir `provider`; todo insert deve gravar `provider`.

- [ ] **Step 5: Adaptar a rota Meta como parser fino**

A rota continua lendo bytes crus, verificando `X-Hub-Signature-256`, usando `after()`, processando template webhooks e descriptografando somente configuracoes `provider = 'meta'`. Depois normaliza e chama o processador comum.

- [ ] **Step 6: Rodar a regressao e comparar cobertura de casos**

Run: `npm test -- src/app/api/whatsapp/webhook/route.test.ts src/lib/whatsapp/inbound src/lib/whatsapp/mirror-inbound-media.test.ts src/lib/whatsapp/wa-identity.test.ts`

Expected: PASS com todos os casos pre-existentes e os novos testes unitarios.

- [ ] **Step 7: Criar o checkpoint Git**

```bash
git add src/lib/whatsapp/inbound src/app/api/whatsapp/webhook
git commit -m "refactor: extract provider-neutral inbound processing"
```

---

### Task 11: Normalizador defensivo e quarentena UAZAPI

**Em termos simples:** aceitar somente mensagens reconhecidas e guardar uma amostra segura quando a documentacao e a carga real nao coincidirem.

**Files:**

- Create: `src/lib/whatsapp/inbound/uazapi-normalizer.ts`
- Test: `src/lib/whatsapp/inbound/uazapi-normalizer.test.ts`
- Create: `src/lib/whatsapp/inbound/webhook-quarantine.ts`
- Test: `src/lib/whatsapp/inbound/webhook-quarantine.test.ts`
- Modify: `src/app/api/automations/cron/route.ts`
- Modify: `src/app/api/flows/cron/route.ts`

**Interfaces:**

- Consumes: envelopes normalizados da Task 10.
- Produces: `normalizeUazapiWebhook(payload)`, `quarantineWebhookFailure()` e `purgeExpiredWebhookQuarantine()`.

- [ ] **Step 1: Criar fixtures derivadas do OpenAPI fornecido**

Os testes devem conter cargas completas para:

- evento `messages` com texto;
- imagem, video, audio e documento com `fileURL`;
- midia sem URL que exige `/message/download`;
- `messages_update` com sent/delivered/read/failed;
- `connection` com disconnected/connecting/connected/hibernated;
- remetente com `sender_pn` e `sender_lid`, depois somente `sender_lid`;
- `fromMe = true`, grupo, tipo desconhecido, `data` ausente e corpo nao objeto.

- [ ] **Step 2: Executar os testes e confirmar a falha**

Run: `npm test -- src/lib/whatsapp/inbound/uazapi-normalizer.test.ts src/lib/whatsapp/inbound/webhook-quarantine.test.ts`

Expected: FAIL por modulos ausentes.

- [ ] **Step 3: Implementar runtime guards sem casts cegos**

Reconhecer os nomes documentados `event`/`EventType`, `messageid`/`id`, `messageTimestamp`, `sender`, `sender_pn`, `sender_lid`, `fromMe`, `isGroup`, `messageType`, `text`, `content`, `fileURL` e status. Ausencia de id, identidade ou tipo reconhecido retorna um resultado `quarantine` com codigo estavel, nunca um envelope parcial.

- [ ] **Step 4: Implementar sanitizacao e deduplicacao**

Remover recursivamente chaves que contenham `token`, `authorization`, `secret`, `qrcode`, `base64`, `binary` e corpos de midia. Serializar no maximo 64 KiB, calcular SHA-256 do corpo bruto antes da sanitizacao e fazer upsert por `(account_id, provider, reason_code, payload_fingerprint)`, incrementando `occurrence_count` e renovando `expires_at` para sete dias.

- [ ] **Step 5: Implementar limpeza limitada**

`purgeExpiredWebhookQuarantine()` deleta `expires_at < now()` e usa um controle em memoria para executar no maximo uma vez por processo a cada 24 horas. Chamar a funcao sem bloquear a resposta nos dois crons autenticados e oportunisticamente apos um upsert de quarentena.

- [ ] **Step 6: Executar os testes**

Run: `npm test -- src/lib/whatsapp/inbound/uazapi-normalizer.test.ts src/lib/whatsapp/inbound/webhook-quarantine.test.ts`

Expected: PASS e snapshots sanitizados sem segredos/base64.

Run: `npm run typecheck`

Expected: PASS, incluindo as duas chamadas nao bloqueantes adicionadas aos crons.

- [ ] **Step 7: Criar o checkpoint Git**

```bash
git add src/lib/whatsapp/inbound src/app/api/automations/cron/route.ts src/app/api/flows/cron/route.ts
git commit -m "feat: normalize and quarantine UAZAPI webhooks"
```

---

### Task 12: Webhook UAZAPI, identidade e midia recebida

**Em termos simples:** receber mensagens reais da UAZAPI, liga-las ao contato certo e guardar anexos antes que o link expire.

**Files:**

- Create: `src/app/api/whatsapp/webhook/uazapi/[secret]/route.ts`
- Test: `src/app/api/whatsapp/webhook/uazapi/[secret]/route.test.ts`
- Create: `src/lib/whatsapp/inbound/uazapi-media.ts`
- Test: `src/lib/whatsapp/inbound/uazapi-media.test.ts`
- Create: `src/lib/whatsapp/inbound/contact-identities.ts`
- Test: `src/lib/whatsapp/inbound/contact-identities.test.ts`
- Modify: `src/lib/whatsapp/inbound/process-inbound-message.ts`
- Modify: `src/lib/whatsapp/inbound/process-status-update.ts`
- Modify: `src/lib/whatsapp/mirror-inbound-media.ts`

**Interfaces:**

- Consumes: normalizador/quarentena da Task 11, processador comum da Task 10 e cliente UAZAPI da Task 5.
- Produces: POST publico UAZAPI, `resolveOrAttachExternalIdentity()` e `resolveUazapiMedia()`.

- [ ] **Step 1: Escrever testes da borda HTTP**

```ts
it('hides whether an unknown secret belongs to an account', async () => {
  const response = await POST(requestWithJson(validText), context('unknown'));
  expect(response.status).toBe(404);
});

it('acks and quarantines a valid-secret unknown payload', async () => {
  const response = await POST(
    requestWithJson({ event: 'messages', data: {} }),
    context(secret)
  );
  expect(response.status).toBe(200);
  expect(quarantineWebhookFailure).toHaveBeenCalledOnce();
  expect(processInboundMessage).not.toHaveBeenCalled();
});

it('returns 503 for a transient database failure', async () => {
  processInboundMessage.mockRejectedValue(new TransientInboundError('db'));
  const response = await POST(requestWithJson(validText), context(secret));
  expect(response.status).toBe(503);
});
```

- [ ] **Step 2: Executar os testes e confirmar a falha**

Run: `npm test -- 'src/app/api/whatsapp/webhook/uazapi/[secret]/route.test.ts' src/lib/whatsapp/inbound/uazapi-media.test.ts src/lib/whatsapp/inbound/contact-identities.test.ts`

Expected: FAIL por rota e servicos ausentes.

- [ ] **Step 3: Implementar autenticacao por hash e limite de corpo**

Ler no maximo 1 MiB antes de `JSON.parse`, calcular `sha256(secret)` e buscar uma unica configuracao `provider = 'uazapi'` por hash. Segredo desconhecido retorna 404. Se o payload contiver instancia, exigir igualdade com `uazapi_instance_id`.

Como esta e uma rota dinamica do Next.js 16, obter o segredo com `const { secret } = await context.params`; nao acessar `context.params.secret` de forma sincrona.

- [ ] **Step 4: Implementar identidade phone/LID**

Com telefone, reutilizar `findExistingContact()` e depois fazer upsert do LID/JID para o contato encontrado. Sem telefone, procurar a identidade externa e carregar seu contato na mesma conta. Sem qualquer chave utilizavel, quarentenar. Uma violacao de unicidade concorrente deve reler a identidade vencedora, como o dedupe atual de telefone.

- [ ] **Step 5: Implementar midia UAZAPI e mirror**

Usar `fileURL` quando presente; quando ausente, chamar `/message/download` com `{ id, return_link: true, return_base64: false }`. Generalizar `mirrorInboundMedia()` para receber uma funcao `download` e credenciais opcionais, mantendo a chamada Meta atual intacta. Validar MIME, timeout e limite `MEDIA_MAX_BYTES`; caminho de storage usa provider + id externo para permanecer idempotente.

- [ ] **Step 6: Processar eventos reconhecidos**

- mensagem: chamar `processInboundMessage()`, inserir `provider = 'uazapi'`, atualizar conversa e disparar flow/automation/IA uma unica vez;
- status: chamar `processStatusUpdate()` com busca por provider e id externo, sem regressao de sent/delivered/read e failed terminal;
- connection: atualizar somente status/perfil/check timestamp da configuracao correspondente;
- fromMe/grupo: responder 200 sem persistir nem disparar automacao;
- formato permanente desconhecido: quarentena + 200;
- falha transitoria DB/storage indispensavel: 503.

- [ ] **Step 7: Confirmar idempotencia por provedor**

Enviar duas vezes a mesma fixture UAZAPI e confirmar um unico `messages` insert, um unico incremento unread e uma unica execucao de automacao/flow/IA. Enviar o mesmo `message_id` com provider Meta e confirmar que sao duas mensagens distintas.

- [ ] **Step 8: Executar testes UAZAPI e regressao Meta**

Run: `npm test -- 'src/app/api/whatsapp/webhook/uazapi/[secret]/route.test.ts' src/lib/whatsapp/inbound src/app/api/whatsapp/webhook/route.test.ts src/lib/whatsapp/mirror-inbound-media.test.ts`

Expected: PASS.

- [ ] **Step 9: Criar o checkpoint Git**

```bash
git add 'src/app/api/whatsapp/webhook/uazapi/[secret]' src/lib/whatsapp/inbound src/lib/whatsapp/mirror-inbound-media.ts
git commit -m "feat: receive UAZAPI WhatsApp events"
```

---

### Task 13: Configuracao da instalacao, documentacao e verificacao final

**Em termos simples:** explicar como ativar, testar tudo que pode ser testado sem uma conta UAZAPI e deixar claro o unico teste que depende de um numero real.

**Files:**

- Modify: `.env.local.example`
- Modify: `README.md`
- Create: `docs/uazapi.md`
- Modify: `docs/whatsapp-connection-troubleshooting.md`

**Interfaces:**

- Consumes: todas as tarefas anteriores.
- Produces: instrucoes operacionais, checklist de smoke test e evidencia de verificacao local.

- [ ] **Step 1: Documentar variaveis sem valores reais**

Adicionar a `.env.local.example`:

```dotenv
# Optional unofficial WhatsApp provider. Keep both tokens server-side.
UAZAPI_ENABLED=false
UAZAPI_BASE_URL=https://your-subdomain.uazapi.com
UAZAPI_ADMIN_TOKEN=replace-with-installation-admin-token
```

Reforcar que `NEXT_PUBLIC_SITE_URL` precisa ser HTTPS publico para o webhook e que nenhum token deve usar prefixo `NEXT_PUBLIC_`.

- [ ] **Step 2: Criar guia operacional legivel**

`docs/uazapi.md` deve cobrir: habilitacao do servidor, escolha em Configuracoes, leitura dos cinco estados, renovacao do QR, recursos Meta desativados, troca destrutiva, retencao de midia por dois dias quando mirror esta desligado, quarentena de sete dias e limitacao de nao haver teste ao vivo nesta implementacao.

- [ ] **Step 3: Adicionar troubleshooting**

Documentar respostas 401/403 da UAZAPI, instancia 404, QR expirado, `hibernated`, webhook sem eventos, `provider_not_supported`, media expirada e como consultar `/webhook/errors` diretamente no servidor sem registrar o token em logs ou tickets.

- [ ] **Step 4: Rodar a suite completa**

Run: `npm test`

Expected: todos os testes PASS.

Run: `npm run typecheck`

Expected: PASS sem erros TypeScript.

Run: `npm run lint`

Expected: PASS sem erros ESLint.

Run: `npm run format:check`

Expected: PASS.

Run: `npm run build`

Expected: build de producao concluido.

- [ ] **Step 5: Validar migracao em banco descartavel**

Run: `npx supabase db reset`

Expected: migracoes `001` a `044` aplicadas. Criar uma linha pelo schema antigo e confirmar `provider = 'meta'`; criar uma linha UAZAPI valida; confirmar rejeicao das duas combinacoes de campos incorretas e executar a RPC de troca dentro de uma transacao.

- [ ] **Step 6: Validar visualmente em desktop e celular**

Iniciar com `npm run dev`, abrir o CRM em 1440x900 e 390x844 e conferir:

- Disparos e Modelos visiveis, desativados e sem navegacao sob UAZAPI;
- botao de sincronizacao e template do Inbox desativados;
- seletor de provedor sem salto de layout;
- QR inteiro, nitido e sem sobreposicao;
- estados conectado, desconectado, hibernado, expirado e erro;
- retorno para Meta reativa os controles.

Salvar capturas de verificacao fora do commit ou no local de artefatos ja usado pelo ambiente; nao adicionar imagens temporarias ao repositorio.

- [ ] **Step 7: Executar o smoke test real quando houver UAZAPI**

Seguir `docs/uazapi.md`: conectar numero descartavel, receber/enviar texto e quatro tipos de midia, verificar status, automacao e fluxo de texto/midia, reconectar e trocar de provedor. Enquanto esta etapa nao for executada, registrar no resumo da entrega: `Validacao UAZAPI ao vivo pendente por ausencia de ambiente de teste`.

- [ ] **Step 8: Revisar segredos e diff final**

Run: `git diff --check`

Expected: nenhuma saida.

Run: `git grep -n -E "admin-secret|plain-instance-token|base64-secret|replace-with-installation-admin-token" -- ':!*.test.ts' ':!*.test.tsx' ':!.env.local.example' ':!docs/superpowers/plans/*'`

Expected: nenhuma saida em codigo de producao.

Run: `git status --short`

Expected: somente arquivos desta funcionalidade antes do commit final.

- [ ] **Step 9: Criar o checkpoint final Git**

```bash
git add -- .env.local.example README.md docs/uazapi.md docs/whatsapp-connection-troubleshooting.md
git commit -m "docs: add UAZAPI setup and verification guide"
```

---

## Resultado Esperado Para O Usuario

Ao final, Configuracoes tera duas escolhas claras. Meta continuara com o formulario atual. UAZAPI mostrara um QR Code, o estado da sessao e acoes simples para renovar, reconectar ou remover. Quando UAZAPI estiver ativa, o usuario continuara usando Inbox, contatos, texto, midia, automacoes e fluxos compatíveis; Modelos, sincronizacao e Disparos permanecerao visiveis, mas nao clicaveis, com uma explicacao curta.

O historico nunca e apagado ao trocar de provedor. O que for incompatível e interrompido de forma explicita para nao enviar algo antigo por engano. A Meta so sera considerada preservada quando toda a suite de regressao passar; a UAZAPI so sera considerada validada em producao depois do smoke test com uma instancia real.
