# Mensalidades automáticas

O módulo **Mensalidades** envia um aviso mensal pelo WhatsApp para um contato do
CRM ou para um número informado manualmente. Proprietários e administradores
podem criar, editar, testar, pausar, reativar e excluir programações.

A mensagem enviada é curta, identifica que é automática, usa o nome do
destinatário, informa o mês de referência e o valor, e pede que a pessoa chame
quando for pagar para receber o Pix.

## Instalação

1. Aplique `supabase/migrations/058_monthly_payment_reminders.sql` no Supabase.
   Em uma instalação nova, execute os arquivos de `supabase/instalacao/` na
   ordem indicada no `LEIA-ME.md` dessa pasta.
2. Garanta que o servidor tenha `NEXT_PUBLIC_SUPABASE_URL` e
   `SUPABASE_SERVICE_ROLE_KEY` configurados.
3. Reinicie ou publique novamente a aplicação para iniciar o agendador.

O agendador interno é ligado por padrão quando as credenciais do Supabase estão
presentes. Ele verifica as cobranças a cada minuto, usa uma trava no banco para
que várias instâncias não processem o mesmo ciclo ao mesmo tempo e registra uma
única entrega por mensalidade e mês de referência.

### Cron externo

Em plataformas onde o processo Node não permanece ativo, use um agendador
externo:

```dotenv
MONTHLY_PAYMENTS_AUTORUN=false
MONTHLY_PAYMENTS_CRON_SECRET=gere-um-segredo-longo-e-aleatorio
```

Faça um `POST` por minuto para `/api/monthly-payments/cron`, enviando o segredo
como Bearer token:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $MONTHLY_PAYMENTS_CRON_SECRET" \
  "https://SEU-DOMINIO/api/monthly-payments/cron"
```

Use apenas um modelo de execução: mantenha o agendador interno ligado ou use o
cron externo. A proteção contra duplicidade continua existindo, mas desligar o
agendador interno evita processamento desnecessário.

## Uso

Abra **Mensalidades** no menu, escolha um contato existente ou informe um nome e
um telefone manualmente, defina o valor, dia e horário e salve. A programação se
repete mensalmente até ser pausada. Quando o dia escolhido não existe no mês
(por exemplo, dia 31 em fevereiro), o envio ocorre no último dia daquele mês. O
fuso usado é `America/Sao_Paulo`.

- **Enviar teste** envia imediatamente, mas não conta como a entrega do mês.
- **Pausar** impede novas competências de serem criadas; uma mensagem que já
  está sendo processada pode terminar.
- **Reativar** volta a calcular o próximo envio mensal.
- **Histórico** mostra sucesso, processamento, nova tentativa ou falha.
- Falhas transitórias voltam a ser tentadas de hora em hora dentro do mesmo mês.
  Uma cobrança não é enviada retroativamente depois que o mês termina.

Excluir uma mensalidade é uma exclusão lógica: ela deixa de aparecer e de gerar
novos envios, mas o histórico permanece no banco para auditoria.

## Provedores do WhatsApp

### UAZAPI

O envio funciona diretamente para contatos e números manuais. Para destinatários
vinculados a um contato, a mensagem também entra no histórico da conversa do
CRM. Para números manuais, o envio é direto e não cria um contato ou conversa
automaticamente.

### API oficial da Meta

A mensagem de mensalidade é texto livre. A Meta só permite esse tipo de envio
dentro da janela de atendimento de 24 horas após a última mensagem do cliente.
Fora dessa janela, o provedor recusará o envio e o histórico da mensalidade
mostrará a falha. Para avisos iniciados pela empresa fora da janela, é necessário
um template aprovado; este módulo não converte a mensagem em template.

## Diagnóstico

- Confirme que a conexão do WhatsApp da conta está ativa.
- Use **Enviar teste** antes de aguardar o horário mensal.
- Consulte o histórico da mensalidade e os logs com os prefixos
  `[monthly-payments-scheduler]` e `[monthly-payments-cron]`.
- Se nada for processado, confira a migração 058, as credenciais do Supabase e se
  `MONTHLY_PAYMENTS_AUTORUN` não foi desativado sem um cron externo configurado.
- Se o contato tiver sido removido, a entrega falhará de forma visível; edite a
  mensalidade e escolha outro destinatário.
