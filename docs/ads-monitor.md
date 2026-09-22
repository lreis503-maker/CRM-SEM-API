# Monitoramento de contas de anúncio

Avisa o cliente no WhatsApp quando o saldo da conta de anúncios da Meta
fica abaixo de um limite, ou quando a cobrança para (cartão recusado,
conta sem forma de pagamento, conta desativada). A equipe recebe uma
cópia de todo aviso.

A mensagem sai pelo provedor de WhatsApp que a conta do CRM já usa e a
conversa com o cliente fica registrada na caixa de entrada, como
qualquer outro atendimento.

---

## 1. O que é preciso

- **Um token de usuário de sistema** do seu Business Manager, com a
  permissão `ads_read` e acesso às contas de anúncio dos clientes.
  Criado em Meta Business Suite → Configurações do negócio → Usuários →
  Usuários do sistema → Gerar novo token.
- **O WhatsApp conectado** no CRM (UAZAPI ou API oficial da Meta).
- **Um agendador** chamando a rota de verificação de tempos em tempos.

### Um aviso sobre a API oficial da Meta

Com a **UAZAPI** o alerta sai como texto livre a qualquer hora. Com a
**API oficial da Meta**, uma mensagem enviada fora da janela de 24 horas
precisa ser um **template aprovado** — texto livre é recusado pela Meta.

O código atual envia texto. Numa conta que use a API oficial, o aviso
só chega se o cliente tiver falado com você nas últimas 24 horas; fora
disso o envio falha e fica gravado em `ad_account_alerts.client_error`.
A cópia interna tem o mesmo limite.

Para usar o monitor na API oficial é preciso criar dois templates
aprovados (saldo baixo e cobrança parada) com variáveis e trocar o
envio para `engineSendTemplate`. Está descrito na seção 7.

---

## 2. Configurar

### 2.1 Variável de ambiente

```dotenv
ADS_MONITOR_CRON_SECRET=<openssl rand -hex 32>
```

É a única variável nova. O token do Business Manager **não** fica em
variável de ambiente: ele é por conta do CRM e é gravado criptografado
com `ENCRYPTION_KEY` na tabela `ad_platform_credential_secrets`, que não
tem nenhuma policy de RLS — nem uma falha futura em outra tabela abre um
caminho do navegador até ele.

### 2.2 Migrações

Rode, **nesta ordem**, no SQL Editor do Supabase (ou `supabase db push`
se você usa a CLI):

1. `supabase/migrations/047_ad_account_monitor.sql`
2. `supabase/migrations/048_ad_platform_multi_portfolio.sql`
3. `supabase/migrations/049_ad_account_funding_display.sql`

A 047 cria:

| Tabela | Para quê |
| --- | --- |
| `ad_platform_credentials` | Metadados de cada portfólio e o número interno da cópia. Legível pela equipe. |
| `ad_platform_credential_secrets` | O token cifrado. Só service role. |
| `ad_account_monitors` | Uma linha por conta de anúncio monitorada. |
| `ad_account_monitor_state` | Última leitura e o estado do alerta, para não repetir aviso. |
| `ad_account_alerts` | Histórico do que foi enviado, com o texto e o erro de entrega. |

A 048 permite **vários portfólios por conta do CRM**. Ela torna o
rótulo obrigatório, remove a unicidade que limitava a um portfólio e
adiciona `ad_account_monitors.credential_id`, ligando cada conta de
anúncio ao portfólio cujo token a lê.

A 049 corrige a leitura de saldo: guarda o texto da forma de pagamento
para diagnóstico e zera o estado dos alertas, porque as leituras
anteriores foram feitas com a regra invertida (veja a seção 3).

As três são seguras de rodar mais de uma vez.

### 2.3 Na tela

Abra `/ads-monitor` (a página ainda não está no menu lateral — veja a
seção 7).

**Conecte um portfólio por vez.** Cada portfólio empresarial da Meta
precisa do seu próprio token de usuário de sistema: o usuário de um
portfólio não enxerga as contas de anúncio do outro. Dê um nome que
você reconheça, cole o token e informe o número interno que recebe as
cópias daquele portfólio — cada um pode avisar uma pessoa diferente.

O token é validado contra a Meta **antes** de ser gravado. Um token que
não funciona é recusado na hora, em vez de virar erro silencioso em todo
ciclo de verificação.

Depois, em "Adicionar conta de anúncio", escolha o portfólio e informe
o identificador da conta, copiado do Gerenciador de Anúncios. Aceita
com ou sem o prefixo `act_`.

Digitar o identificador contorna a listagem, mas **não** contorna a
permissão: a conta precisa estar nos ativos daquele usuário de sistema,
com "Gerenciar conta de anúncios". Sem isso a leitura falha com erro de
acesso na primeira verificação.

Para desconectar um portfólio, remova antes as contas ligadas a ele. A
remoção é recusada enquanto houver alguma, para uma desconexão não
apagar monitores em silêncio.

### 2.4 Agendador

No Railway, crie um cron que chame:

```bash
curl -fsS -H "x-cron-secret: $ADS_MONITOR_CRON_SECRET" \
  "https://SEU-DOMINIO/api/ads/monitor/cron"
```

A cada 15 minutos é um bom intervalo. A rota aceita:

- `limit` — máximo de contas por execução (padrão 100, teto 500);
- `min_interval_minutes` — não relê uma conta verificada há menos que
  isso (padrão 10). É o que protege a cota da Meta se o agendador for
  mais frequente que o necessário.

A resposta é `{ checked, skipped, alerts, failures }`.

---

## 3. Como a regra decide

### Saldo

**O campo `balance` da Meta não é o saldo.** Ele é a fatura em aberto —
quanto a conta deve — e **cresce** conforme os anúncios gastam. Usá-lo
como saldo inverte o alerta: ele dispararia com o cliente tendo gasto
pouco e silenciaria conforme ele gasta. Foi o bug da primeira versão,
corrigido na 049.

O saldo de verdade vem de `funding_source_details.display_string`, que
carrega o mesmo texto do Gerenciador de Anúncios:

```json
"funding_source_details": {
  "display_string": "Saldo disponível (R$278,60 BRL)",
  "type": 20
}
```

Não existe campo numérico equivalente no nó da conta, então o número é
extraído desse texto. A ordem de preferência, em
`src/lib/ads/account-health.ts`:

| Origem | Quando | Confiabilidade |
| --- | --- | --- |
| `funding_source_details.display_string` | conta pré-paga com texto legível | exata — é o número do Gerenciador |
| `spend_cap − amount_spent` | o texto não pôde ser lido | aproximada, erra para baixo |
| nenhuma | nem texto nem limite de gastos | a regra de saldo não roda |

A leitura do texto só acontece quando `is_prepay_account` é `true`, e
exige um símbolo de moeda colado ao número. Sem essa guarda, o
`display_string` de um cartão ("Visa ···· 1234") viraria um saldo de
R$ 1.234 e mandaria alerta errado para o cliente.

A rede do `spend_cap` costuma ficar abaixo do saldo real — na conta que
serviu de referência, R$ 244,75 contra R$ 278,60 — então ela avisa cedo
demais em vez de tarde demais, que é o erro certo a cometer.

> **Confira a primeira leitura.** Depois de cadastrar uma conta, clique
> em "Verificar agora" e compare o saldo com o do Gerenciador de
> Anúncios. Os valores crus ficam em `ad_account_monitor_state`
> (`balance_cents` é a fatura, `available_cents` é o saldo comparado, e
> `funding_source_display` é o texto de onde ele saiu).

### Cobrança

Na ordem, do mais específico para o mais genérico:

| Sinal | Código | O que aconteceu |
| --- | --- | --- |
| `funding_source` ausente | `no_funding_source` | Conta sem forma de pagamento; anúncios não entregam |
| `account_status` 3 | `unsettled` | Fatura em aberto — normalmente cartão recusado |
| `account_status` 9 | `in_grace_period` | Pagamento falhou, conta no prazo extra |
| `account_status` 8 | `pending_settlement` | Cobrança pendente |
| `account_status` 7 | `risk_review` | Conta em análise |
| `account_status` 2 | `disabled` | Conta desativada |
| `account_status` 100 / 101 | `pending_closure` / `closed` | Encerrando / encerrada |

Um `account_status` que a regra não conhece **não** vira alerta: ele é
gravado no retrato e ignorado. Inventar significado para um código novo
da Meta é como se manda a mensagem errada para o cliente.

### Repetição

- O aviso sai quando o problema **começa**.
- Enquanto continuar igual, repete no máximo uma vez por
  `cooldown_hours` (padrão 24; zero = avisar só na transição).
- Se o problema **mudar de natureza** (de `unsettled` para `disabled`,
  por exemplo), avisa na hora, mesmo dentro do intervalo.
- O aviso de normalização só sai para quem chegou a receber o alerta.
- O saldo só "normaliza" quando passa de **120% do limite**. Sem essa
  margem, uma conta parada em cima da linha mandaria "acabou" e "voltou"
  alternadamente.

### Quando a leitura falha

| Tipo de falha | Quando a equipe é avisada |
| --- | --- |
| Token expirado, acesso removido, conta inexistente | Na primeira falha |
| Meta fora do ar, limite de chamadas | Na terceira falha seguida |

O cliente **nunca** é avisado de falha de leitura: não é problema dele.

---

## 4. Arquivos

```
supabase/migrations/047_ad_account_monitor.sql
supabase/migrations/048_ad_platform_multi_portfolio.sql
supabase/migrations/049_ad_account_funding_display.sql

src/lib/ads/
  meta-ads-errors.ts        erros tipados, classificação, redação do corpo
  meta-ads-client.ts        cliente somente-leitura da Marketing API
  account-health.ts         a regra (função pura)
  alert-message.ts          os textos, cliente e interno
  credentials.ts            portfólios e tokens cifrados
  internal-phone.ts         validação do número da cópia interna
  monitor-runner.ts         o ciclo: ler, decidir, enviar, gravar

src/app/api/ads/
  credentials/route.ts                    GET listar · POST conectar
  credentials/[id]/route.ts               PATCH · DELETE
  credentials/[id]/ad-accounts/route.ts   GET, contas que o token enxerga
  accounts/route.ts                       GET listar · POST cadastrar
  accounts/[id]/route.ts                  PATCH · DELETE
  monitor/cron/route.ts                   GET, protegida por segredo
  monitor/run/route.ts                    POST, o "verificar agora" da tela

src/app/(dashboard)/ads-monitor/
  page.tsx                  servidor: carrega dados iniciais
  ads-monitor-client.tsx    a tela
```

Testes: `account-health.test.ts`, `meta-ads-client.test.ts`,
`alert-message.test.ts`, `monitor-runner.test.ts` e
`api/ads/monitor/cron/route.test.ts` — 107 casos no total.

## 4.1 O que o cliente recebe

O aviso de saldo diz só que o saldo ficou abaixo do limite:

> Oi, Ana! O saldo da conta de anúncios **Loja da Ana** está abaixo de
> R$ 100,00.

Sem o saldo exato, de propósito: o número já estará velho quando a
pessoa abrir o Gerenciador de Anúncios, e uma mensagem de WhatsApp pode
ser encaminhada. O valor exato vai na cópia interna, junto do
identificador da conta, porque quem lê ali vai agir sobre ele.

Para mudar qualquer um desses textos, o arquivo é
`src/lib/ads/alert-message.ts` — ele existe separado da regra
justamente porque muda por outro motivo.

---

## 5. Segurança

- O token vai no header `Authorization: Bearer`, **nunca** em
  `?access_token=`. Query string aparece em log de proxy e em mensagem
  de erro; header não.
- O corpo de erro da Meta é reduzido a `code`, `type`, `message` e
  `fbtrace_id` antes de virar log. Campos desconhecidos não atravessam.
- `GET /api/ads/credentials` devolve metadados; o token não volta nem
  mascarado. `last_verified_at` já responde "está funcionando?".
- Toda escrita usa service role **depois** de `requireRole('admin')`, e
  filtra por `account_id` — o id do recurso sozinho não prova posse.
- O cliente é lido com filtro `account_id` antes de qualquer envio: a
  mesma defesa que o envio das automações faz.

---

## 6. Diagnóstico

```sql
-- O que o CRM enxerga de cada conta agora, por portfólio
select c.label as portfolio,
       m.external_account_id, m.display_name,
       s.available_cents, s.currency, s.account_status,
       s.low_balance_active, s.payment_issue_code,
       s.checked_at, s.consecutive_failures, s.last_error
from ad_account_monitors m
left join ad_account_monitor_state s on s.monitor_id = m.id
left join ad_platform_credentials c on c.id = m.credential_id
order by c.label, m.created_at;

-- Avisos recentes e se chegaram
select created_at, kind, reason_code, delivery_status,
       client_error, internal_error
from ad_account_alerts
order by created_at desc
limit 50;
```

| Sintoma | Causa provável |
| --- | --- |
| `delivery_status = 'skipped'` | Monitor sem contato vinculado e sem número interno |
| `client_error` falando de janela/template | Conta na API oficial da Meta — veja a seção 7 |
| `last_error` sobre token | Token daquele portfólio expirou ou perdeu `ads_read` |
| `last_error` falando de portfólio | Conta sem portfólio escolhido — abra a tela e selecione |
| Uma conta some da lista de "Buscar contas" | O usuário de sistema daquele portfólio não tem acesso a ela |
| `available_cents` nulo sempre | Nem texto de saldo nem limite de gastos: só a regra de cobrança se aplica |
| Saldo diferente do Gerenciador | Veja `funding_source_display`: se estiver vazio, o saldo veio do limite de gastos e é aproximado |
| Nenhum alerta e `checked_at` antigo | O agendador não está chamando a rota |

---

## 7. O que ficou de fora

1. **Link no menu lateral.** A página existe em `/ads-monitor` mas não
   está registrada em `src/app/(dashboard)/dashboard-shell.tsx`, porque
   o menu tem rótulos traduzidos nos quatro catálogos de `messages/`.
   Adicionar o item e as quatro chaves é a última etapa.
2. **Templates para a API oficial da Meta.** Ver a seção 1. Envolve
   criar dois templates aprovados e trocar, em `monitor-runner.ts`, a
   função `defaultSendToContact` para usar `engineSendTemplate` quando
   `loadProviderTransport` devolver `provider === 'meta'`.
3. **Controles do design system.** A tela usa `<select>` e
   `<input type="checkbox">` nativos em vez de `Select` e `Switch`. É
   ajuste visual, não muda comportamento.
4. **Google Ads e TikTok Ads.** O banco já separa por `platform`, mas
   só `'meta'` é aceito pelo CHECK. Um segundo conector entra criando
   `src/lib/ads/<plataforma>-client.ts` com a mesma forma de
   `MetaAdAccountSnapshot` e ampliando o CHECK.
