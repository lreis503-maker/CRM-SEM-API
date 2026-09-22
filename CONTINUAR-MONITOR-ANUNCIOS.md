# Transferência do projeto: monitor de contas de anúncio

Atualizado em: 2026-09-22

Arquivo de continuação, no mesmo formato de
`CONTINUAR-PROJETO-UAZAPI.md`. Permite retomar o trabalho em outra
sessão sem depender do histórico da conversa.

## 1. Pedido original do usuário

Avisar os clientes pelo WhatsApp quando o saldo da conta de anúncios
ficar abaixo de R$ 100 ou quando o cartão parar. As mensagens saem pelo
CRM, que já tem o WhatsApp conectado.

Decisões confirmadas pelo usuário:

- plataforma: **Meta Ads** apenas (Google Ads e TikTok ficam para depois);
- acesso: **token de usuário de sistema do Business Manager da agência**,
  uma credencial que enxerga as contas de todos os clientes;
- destinatário: **o cliente, com cópia interna** para a equipe;
- transporte: **UAZAPI** é o provedor ativo, então o alerta é texto livre.

## 2. Estado: implementado e verificado

Toda a funcionalidade está escrita. O que foi verificado nesta sessão,
num ambiente isolado com Vitest 4 e TypeScript em modo `strict`:

- **91 testes passando** (5 arquivos);
- **`tsc --noEmit` sem erros** em todos os arquivos novos, incluindo as
  rotas e a tela.

O que **não** foi verificado, por não haver acesso:

- a suíte completa do repositório (`npm test`) e o `npm run lint`;
- a migração 047 contra um Postgres real;
- um ciclo ao vivo com token real da Meta e número de WhatsApp real.

Nenhum arquivo existente do repositório foi alterado, com uma exceção:
`.env.local.example` ganhou uma seção no fim. Todo o resto é arquivo
novo, então não há risco de ter sobrescrito trabalho em andamento.

## 3. Arquivos criados

Ver a seção 4 de `docs/ads-monitor.md` para a lista completa com a
responsabilidade de cada um. Resumo:

- `supabase/migrations/047_ad_account_monitor.sql`
- `src/lib/ads/` — 6 módulos + 4 arquivos de teste
- `src/app/api/ads/` — 5 rotas + 1 arquivo de teste
- `src/app/(dashboard)/ads-monitor/` — página e componente
- `docs/ads-monitor.md`

## 4. Primeiros passos nesta máquina

O trabalho foi escrito direto na árvore de `crm2`. Antes de qualquer
coisa, veja em que branch ele caiu e isole se for `main`:

```powershell
cd "C:\Users\'\Desktop\CRM SEM API\crm2"
git branch --show-current
git status --short
```

Se estiver em `main`, crie a branch antes de commitar:

```powershell
git checkout -b feat/ads-account-monitor
```

Depois rode a verificação completa:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

Commit sugerido, num único commit por ser uma funcionalidade coesa:

```
feat: add Meta ad account balance and billing monitor
```

## 5. O que falta

Em ordem de importância. Os detalhes de cada item estão na seção 7 de
`docs/ads-monitor.md`.

### Tarefa A — link no menu lateral

`src/app/(dashboard)/ads-monitor/page.tsx` existe e funciona, mas a
página não está em `src/app/(dashboard)/dashboard-shell.tsx`. Adicionar
o item exige uma chave de tradução nos quatro catálogos de `messages/`
(`pt-BR`, `en`, `ko`, `es`). Foi deixado de fora de propósito: mexer no
menu e nos catálogos sem ver o arquivo inteiro é o tipo de mudança que
quebra build por um detalhe.

### Tarefa B — conferir a leitura de saldo contra o Gerenciador

Cadastre **uma** conta de anúncio real, clique em "Verificar agora" e
compare o saldo mostrado com o do Gerenciador de Anúncios. A Meta não
tem um campo único de "saldo restante"; o cálculo por tipo de conta
está documentado e testado, mas só uma conta real confirma que o
mapeamento está certo para as suas contas.

Se divergir, o ajuste é em `resolveAvailableBalance`, em
`src/lib/ads/account-health.ts`. Os valores crus ficam gravados em
`ad_account_monitor_state` justamente para essa comparação.

**Não declare a integração validada ao vivo sem esse teste.**

### Tarefa C — templates, se algum dia trocar para a API oficial

Hoje não é necessário: na UAZAPI o texto livre funciona. Vira
obrigatório se alguma conta do CRM passar a usar a API oficial da Meta,
porque mensagem proativa fora da janela de 24 horas exige template
aprovado. O ponto de mudança é `defaultSendToContact`, em
`src/lib/ads/monitor-runner.ts`.

### Tarefa D — controles do design system na tela

Trocar `<select>` e `<input type="checkbox">` nativos por `Select` e
`Switch` de `src/components/ui/`. Puramente visual.

### Tarefa E — outras plataformas

O banco já separa por `platform`, mas o CHECK só aceita `'meta'`. Um
segundo conector entra com um cliente novo que devolva a mesma forma de
`MetaAdAccountSnapshot` e uma migração ampliando o CHECK.

## 6. Decisões de arquitetura a preservar

- O token do Business Manager fica cifrado em
  `ad_platform_credential_secrets`, tabela com RLS ligada e **sem
  nenhuma policy**. Mesmo padrão de `whatsapp_config_secrets` na 043.
- O token viaja no header `Authorization`, nunca na query string.
- O corpo de erro da Meta é reduzido a campos conhecidos antes de virar
  log.
- `GET /api/ads/credentials` nunca devolve o token, nem mascarado.
- Toda escrita é service role **depois** de `requireRole('admin')`, com
  filtro por `account_id`.
- A regra de alerta (`account-health.ts`) é função pura, sem banco e sem
  rede. É o pedaço que mais precisa estar certo — um falso positivo
  manda mensagem errada para o cliente do usuário.
- Um `account_status` desconhecido não vira alerta.
- Conta pós-paga sem limite de gastos não tem saldo a comparar; a regra
  de saldo não roda nela.
- Alerta de normalização só para quem recebeu o alerta original.
- Falha de leitura nunca chega ao cliente, só à equipe.
- A mensagem do cliente entra pela mesma porta das automações
  (`engineSendText`), então aparece na caixa de entrada. A cópia interna
  vai direto pelo transporte, sem criar contato.
- O segredo do cron é `ADS_MONITOR_CRON_SECRET`, separado de
  `AUTOMATION_CRON_SECRET`.

## 7. Observação sobre a numeração das migrações

O repositório tem **duas** migrações com o prefixo 043:
`043_instagram_messaging.sql` e `043_uazapi_provider.sql`. Não é
problema deste trabalho e nada foi mexido, mas dependendo de como você
aplica as migrações a ordem entre essas duas pode ficar indefinida.
Vale renomear uma delas antes que uma terceira apareça.

A migração nova é a `047`, sem conflito.

---

# Atualização — 2026-09-22, tarde

A integração foi validada ao vivo: o primeiro alerta de saldo baixo
chegou no WhatsApp do cliente pelo CRM. Duas mudanças pedidas depois
disso já estão implementadas.

## 1. Mensagem do cliente encurtada

O aviso de saldo agora diz apenas que o saldo ficou abaixo do limite,
sem o saldo exato e sem o parágrafo de orientação:

> Oi, Ana! O saldo da conta de anúncios **Loja da Ana** está abaixo de
> R$ 100,00.

O aviso de normalização seguiu a mesma regra. A cópia interna continua
com o valor exato e o identificador da conta — quem lê ali vai agir
sobre o número.

Arquivo: `src/lib/ads/alert-message.ts`.

## 2. Vários portfólios empresariais por conta do CRM

A 047 assumia um portfólio por conta. O usuário tem dois, com quatro
contas de anúncio cada, e o usuário de sistema de um portfólio não
enxerga as contas do outro — então são dois tokens.

Migração nova: `supabase/migrations/048_ad_platform_multi_portfolio.sql`.

- `ad_platform_credentials.label` vira obrigatório e é o nome do
  portfólio, único por conta do CRM;
- a unicidade `(account_id, platform)` foi removida;
- `ad_account_monitors.credential_id` liga cada conta de anúncio ao
  portfólio que a lê, com `ON DELETE RESTRICT`.

O backfill atribui as linhas existentes ao único portfólio da conta e
só aplica `NOT NULL` se nenhuma linha ficar órfã — uma conta sem
credencial não derruba a migração, o runner pula o monitor e grava o
motivo.

Mudanças de código:

- `credentials.ts` passou a listar, criar, editar e remover portfólios,
  e a devolver o token por `credential_id`;
- `monitor-runner.ts` agrupa por portfólio: decifra cada token uma vez
  por ciclo e usa o número interno daquele portfólio;
- rotas novas `credentials/[id]` e `credentials/[id]/ad-accounts`;
- `internal-phone.ts` saiu da rota porque arquivo de rota do Next só
  pode exportar handlers HTTP;
- a tela ganhou gestão de portfólios e escolhe as contas de anúncio a
  partir da lista que o token enxerga.

## Verificação

94 testes passando e `tsc --noEmit` limpo, no mesmo ambiente isolado.
Continua sem rodar a suíte completa do repositório nem o lint.

## Para aplicar

1. `git add` dos arquivos novos e alterados, commit e push;
2. rodar a `048` no SQL Editor do Supabase;
3. abrir `/ads-monitor`, renomear o portfólio existente, conectar o
   segundo e conferir se cada conta ficou no portfólio certo.

O passo 3 importa: as contas que já existiam foram atribuídas ao
portfólio antigo pelo backfill. As do segundo portfólio precisam ser
cadastradas, e qualquer conta que tenha ficado no portfólio errado
falha na leitura com erro de permissão até ser corrigida na tela.
