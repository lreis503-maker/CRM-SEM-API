# Mensalidades automáticas pelo WhatsApp

Data: 2026-10-20

## Objetivo

Criar um módulo próprio chamado **Mensalidades** para programar avisos mensais de pagamento pelo WhatsApp conectado ao CRM. Proprietários e administradores poderão criar uma mensalidade, escolher o destinatário, definir valor, dia e horário, e mantê-la ativa até ser pausada manualmente.

O envio precisa acontecer uma única vez por competência mensal, aparecer no histórico da conversa quando o destinatário for um contato do CRM e registrar sucesso ou erro de forma visível.

## Experiência do usuário

O menu lateral terá a entrada **Mensalidades**, visível para `owner` e `admin`. A página `/monthly-payments` mostrará:

- mensalidades ativas e pausadas;
- nome e telefone do destinatário;
- valor;
- dia e horário configurados;
- próximo envio;
- último resultado de envio;
- ações para criar, editar, pausar, reativar e excluir;
- ação **Enviar teste**, que envia a mensagem imediatamente sem consumir a competência do mês nem alterar o próximo agendamento.

O formulário permitirá duas formas de destinatário:

1. **Contato do CRM:** selecionar um contato existente. Nome e telefone serão obtidos do contato no momento do envio, para respeitar correções feitas posteriormente no cadastro.
2. **Número avulso:** informar nome e telefone internacional manualmente. Ambos serão obrigatórios.

Campos da mensalidade:

- destinatário;
- valor em reais;
- dia do mês, de 1 a 31;
- horário local;
- estado ativo ou pausado.

A recorrência não terá data final. Se o dia escolhido não existir em determinado mês, o envio ocorrerá no último dia desse mês. Todo cálculo de agenda usará `America/Sao_Paulo`, inclusive quando o servidor estiver em outro fuso.

## Mensagem

O texto não será editável nesta primeira versão. Isso mantém a comunicação uniforme e evita configurações incompletas.

Formato:

```text
🤖 *Mensagem automática*
Olá, João! A mensalidade referente a outubro está no valor de R$ 500,00.
Quando for realizar o pagamento, me chame por aqui para eu enviar o Pix.
```

Nome, mês e valor serão preenchidos no momento do envio. O mês será escrito em português brasileiro e o valor usará formatação monetária `pt-BR`.

## Persistência

A migração `058_monthly_payment_reminders.sql` criará três estruturas.

### `monthly_payment_reminders`

Configuração permanente da mensalidade:

- `id UUID`;
- `account_id UUID`;
- `contact_id UUID NULL`;
- `recipient_name TEXT NULL`;
- `recipient_phone TEXT NULL`;
- `amount_cents BIGINT` positivo;
- `currency TEXT` com padrão `BRL`;
- `send_day SMALLINT` entre 1 e 31;
- `send_time TIME`;
- `timezone TEXT` com padrão `America/Sao_Paulo`;
- `enabled BOOLEAN`;
- `starts_at TIMESTAMPTZ`, que impede envio retroativo no mês de criação ou reativação;
- `deleted_at TIMESTAMPTZ NULL` para exclusão lógica;
- `created_by UUID`;
- `created_at` e `updated_at`.

Uma restrição garantirá que exista um `contact_id` ou o par `recipient_name`/`recipient_phone`, nunca uma configuração sem destinatário.

### `monthly_payment_deliveries`

Histórico e proteção contra duplicidade:

- `id UUID`;
- `reminder_id UUID`;
- `account_id UUID`;
- `competence DATE`, sempre o primeiro dia do mês de referência;
- `scheduled_for TIMESTAMPTZ`;
- `status`: `pending`, `processing`, `sent` ou `failed`;
- `attempts INTEGER`;
- `processing_at`, `next_attempt_at`, `sent_at` e `updated_at`;
- `last_error TEXT` sanitizado e limitado;
- metadados do destinatário e texto efetivamente usados no envio.

Haverá unicidade em `(reminder_id, competence)`. Mesmo que duas instâncias do CRM executem juntas, somente uma entrega poderá existir para aquela mensalidade naquele mês.

### `monthly_payment_scheduler_lease`

Uma linha de concessão temporária coordenará o agendador entre múltiplas instâncias. A trava expirará automaticamente caso um processo morra durante o ciclo.

As tabelas terão RLS. Proprietários e administradores poderão consultar configurações e histórico. Toda escrita passará pelas rotas autenticadas do servidor; o executor usará service role sempre filtrando por `account_id`.

## Agendamento e concorrência

`src/instrumentation.ts` inicializará um scheduler de mensalidades no runtime Node, ao lado do scheduler do monitor de anúncios.

O scheduler:

1. acordará uma vez por minuto;
2. adquirirá a concessão no banco;
3. localizará mensalidades ativas cujo horário local já venceu no mês atual;
4. criará ou localizará a entrega da competência;
5. reivindicará entregas pendentes ou falhas elegíveis;
6. enviará a mensagem;
7. gravará sucesso ou erro.

Falhas poderão ser tentadas novamente, com intervalo mínimo, até o envio ser confirmado. Uma entrega `sent` nunca será reenviada automaticamente. A operação de reivindicação deverá ser atômica no banco para evitar que duas instâncias enviem a mesma cobrança.

Ao criar ou reativar uma mensalidade depois do horário previsto no mês corrente, o primeiro envio ficará para o mês seguinte. Isso evita uma cobrança inesperada imediatamente após salvar. Editar valor, destinatário ou horário também não reabre uma competência já enviada.

## Envio pelo WhatsApp

Para contatos cadastrados, o runner reutilizará o fluxo existente de resolução de conversa e `engineSendText`. Assim, a mensagem ficará visível no inbox e usará o provider ativo da conta.

Para números avulsos, o runner usará `loadProviderTransport` diretamente e não criará contato nem conversa.

A UAZAPI permite esse envio proativo em texto livre. Na API oficial da Meta, mensagens fora da janela de atendimento de 24 horas exigem template aprovado. Nesta primeira versão, a tela exibirá um aviso quando o provider ativo for Meta; falhas dessa restrição aparecerão no histórico. Suporte a template de cobrança fica fora deste escopo.

## API

Rotas autenticadas, limitadas a `admin`:

- `GET /api/monthly-payments`: lista mensalidades e último resultado;
- `POST /api/monthly-payments`: cria;
- `PUT /api/monthly-payments/[id]`: edita, pausa ou reativa;
- `DELETE /api/monthly-payments/[id]`: exclui;
- `POST /api/monthly-payments/[id]/test`: envia teste sem registrar competência;
- `GET /api/monthly-payments/[id]/deliveries`: lista histórico;
- `POST /api/monthly-payments/cron`: execução por agendador externo, protegida por segredo.

O scheduler interno poderá ser desligado por `MONTHLY_PAYMENTS_AUTORUN=false`. A rota de cron usará `MONTHLY_PAYMENTS_CRON_SECRET`, separado dos outros segredos de agendamento.

## Validação e tratamento de erros

- valor precisa ser maior que zero e será armazenado em centavos;
- telefone avulso será normalizado para dígitos internacionais;
- contato precisa pertencer à mesma conta;
- nome efetivo não pode ficar vazio;
- dia deve estar entre 1 e 31;
- horário deve ser válido;
- erros do provider serão reduzidos a texto seguro antes de serem persistidos;
- excluir ou desativar um contato fará o envio falhar de forma visível, sem redirecionar para outro telefone;
- uma mensalidade pausada não gera novas competências;
- exclusão preservará o histórico por meio de exclusão lógica da configuração, evitando perder auditoria de mensagens já enviadas.

## Interface e traduções

A página seguirá o design system existente e terá estados responsivos para desktop e celular. O formulário usará os componentes de `src/components/ui`. Novas chaves serão incluídas em `pt`, `en`, `es` e `ko`; o conteúdo da mensagem enviada continuará em português, conforme a finalidade operacional definida.

## Testes

Testes unitários cobrirão:

- cálculo do próximo envio e meses curtos;
- horário de São Paulo independentemente do fuso do servidor;
- formatação de nome, competência e valor;
- validação das duas formas de destinatário;
- criação de apenas uma entrega por competência;
- concorrência e recuperação de uma reivindicação expirada;
- ausência de reenvio após `sent`;
- retry controlado após falha;
- pausa, reativação e edição;
- envio de teste sem consumir a competência;
- autorização por papel e isolamento por `account_id`.

A verificação final incluirá `npm test`, `npm run typecheck`, lint direcionado aos arquivos modificados e `npm run build` quando as variáveis locais permitirem.

## Fora do escopo

- receber ou conciliar pagamentos automaticamente;
- marcar mensalidade como paga;
- gerar Pix ou QR Code;
- enviar chave Pix automaticamente;
- juros, multa ou desconto;
- anexos e boletos;
- recorrência semanal ou anual;
- template aprovado para mensagens proativas na API oficial da Meta;
- envio em massa de uma única mensalidade para vários contatos.
