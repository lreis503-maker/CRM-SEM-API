# Conectar o WhatsApp pela UAZAPI (QR Code)

Cada conta do CRM escolhe **uma** forma de conectar o WhatsApp:

- **API oficial da Meta** — o que já existia. Recursos completos, incluindo
  Modelos, sincronização e Disparos.
- **UAZAPI** — conexão por QR Code, sem aprovação da Meta. Atende conversas
  individuais com texto, imagem, vídeo, áudio e documento.

Trocar de provedor não apaga nada: contatos, conversas e mensagens continuam
no lugar, e você pode voltar para a Meta depois.

---

## 1. Habilitar no servidor (responsável pela instalação)

A UAZAPI pertence à instalação, não a uma conta. Enquanto o servidor não
estiver configurado, a opção aparece em Configurações **visível e
desativada**, com um aviso de que o responsável precisa habilitá-la.

Defina, no ambiente do servidor:

```dotenv
UAZAPI_ENABLED=true
UAZAPI_BASE_URL=https://seu-subdominio.uazapi.com
UAZAPI_ADMIN_TOKEN=token-de-administrador-da-instalacao
```

E confirme que `NEXT_PUBLIC_SITE_URL` é o endereço público HTTPS do CRM.

Regras que o servidor verifica antes de liberar a opção:

| Variável               | Exigência                                             |
| ---------------------- | ----------------------------------------------------- |
| `UAZAPI_ENABLED`       | exatamente `true`                                     |
| `UAZAPI_BASE_URL`      | HTTPS, sem caminho e sem usuário/senha na URL         |
| `UAZAPI_ADMIN_TOKEN`   | preenchido                                            |
| `NEXT_PUBLIC_SITE_URL` | URL válida; precisa ser pública para o webhook chegar |

Se qualquer uma falhar, a UAZAPI fica indisponível para todas as contas. O
navegador nunca recebe o nome da variável que falta nem o valor de nenhuma
delas.

### Segurança

- `UAZAPI_ADMIN_TOKEN` só é usado para **criar** uma instância. Todas as
  outras chamadas usam o token da própria instância.
- O token da instância é criptografado (AES-256-GCM) e guardado em
  `whatsapp_config_secrets`, uma tabela sem nenhuma política de leitura pelo
  navegador. Só o servidor alcança.
- O endereço do webhook carrega um segredo aleatório. No banco fica apenas o
  hash SHA-256 dele.
- O QR Code nunca é gravado no banco nem em log: é lido da UAZAPI,
  normalizado e entregue à sessão autenticada.
- Nenhum token, segredo ou QR aparece em resposta HTTP, log ou diagnóstico.

### Migrações

Aplique, em ordem, `043_uazapi_provider.sql` e
`044_uazapi_provider_switch.sql`. A 043 é aditiva: toda linha existente vira
`provider = 'meta'` e continua funcionando sem nenhuma ação do usuário.

---

## 2. Conectar (usuário da conta)

Em **Configurações → WhatsApp**:

1. Escolha **UAZAPI (QR Code)** e confirme a troca. A caixa de confirmação
   diz o que será desligado e lembra que o histórico permanece.
2. Leia o QR Code com o celular da empresa: WhatsApp → **Aparelhos
   conectados** → ler o código.
3. A tela acompanha sozinha e muda para **Conectado** assim que o celular
   confirmar.

Só administradores da conta podem trocar de provedor ou mexer na conexão.
Qualquer membro pode ver o estado.

### Os cinco estados

| Estado                  | O que significa                                       | O que fazer                                    |
| ----------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| Ainda não conectado     | Nenhuma instância criada                              | **Conectar por QR Code**                       |
| Aguardando a leitura    | QR na tela, válido por 2 minutos                      | ler com o celular                              |
| Conectado               | Sessão ativa                                          | nada; envie e receba normalmente               |
| Sessão pausada          | A UAZAPI hibernou a sessão, com as credenciais salvas | **Reconectar**                                 |
| Desconectado / Com erro | Sessão encerrada ou o provedor não respondeu          | **Gerar novo QR Code** ou **Tentar novamente** |

### QR Code expirado

O código vale 2 minutos. Depois disso a tela para de esperar e oferece
**Gerar novo QR Code**, que pede um código novo **para a mesma instância** —
não cria outra. Recarregar a página durante o pareamento retoma a mesma
tentativa.

---

## 3. O que muda com a UAZAPI ativa

Funciona:

- conversas individuais com texto, imagem, vídeo, áudio e documento;
- Caixa de entrada, contatos, conversas e histórico;
- automações e fluxos cujas etapas usem texto ou mídia;
- resposta automática com IA em texto;
- status de entrega quando a UAZAPI informa.

Fica **visível, explicado e sem clique**:

- Modelos/Templates e **Sincronizar com a Meta**;
- **Disparos** (inclusive por URL digitada — a página redireciona);
- botão de modelo na Caixa de entrada;
- etapa `send_template` em automações;
- nós de botões e listas em fluxos;
- reações e localização.

O bloqueio também vale no servidor: chamar essas APIs direto responde
HTTP 409 com `{"error":"provider_not_supported", ...}`. A interface
desativada não é a proteção, é só o aviso.

Não entram nesta versão: canais e newsletters, menus, botões, listas,
contatos, pagamentos e campanhas da UAZAPI.

### Grupos e mensagens enviadas pelo celular

Chegam e ficam visíveis na Caixa de entrada:

- **Grupos.** A conversa pertence ao grupo, não a quem falou. O grupo vira
  um contato com o nome do grupo e sem telefone, e cada mensagem guarda o
  nome de quem escreveu, para a thread não parecer uma voz só.
- **Mensagens digitadas no próprio celular.** Aparecem como mensagem da
  empresa (`agent`), na mesma thread do cliente. Não contam como não
  lidas nem acionam automações, IA ou webhooks de saída — quem respondeu
  foi uma pessoa, do lado de cá.

O que o CRM envia pela API continua sendo filtrado no provedor
(`wasSentByApi`): já está gravado no envio, e deixar uma automação ver a
própria saída é como um robô acaba respondendo a si mesmo.

### Janela de 24 horas

A regra das 24 horas é da Meta. Com a UAZAPI ativa, o CRM não aplica esse
bloqueio — o provedor tem as próprias regras de uso.

---

## 4. Trocar de provedor

**Meta → UAZAPI.** A Meta só é desligada depois que a instância existe e o
webhook está registrado. Na mesma transação, o CRM interrompe o que a UAZAPI
não consegue executar:

- disparos em `agendado` ou `enviando` viram `cancelado`, com motivo
  `provider_switched`;
- automações ativas com `send_template` são desativadas;
- fluxos ativos com botões ou listas voltam para rascunho, e as execuções em
  andamento desses fluxos são encerradas.

Nada é apagado, e a tela mostra quantos itens foram afetados.

**UAZAPI → Meta.** As credenciais da Meta são validadas primeiro. Só então a
sessão UAZAPI é encerrada — e a instância **continua existindo** até a Meta
registrar com sucesso. Se a Meta falhar, a linha UAZAPI fica em
`desconectado` e você pode gerar um novo QR Code. Dando certo, a instância é
removida e a conta volta a ser Meta.

**Remover a conexão.** Desconecta, apaga a instância na UAZAPI e só então
remove a linha local. Uma instância que já não existe conta como removida.

---

## 5. Mídia recebida

A UAZAPI mantém os arquivos hospedados por **dois dias**.

- Com **espelhamento de mídia ligado** (padrão), o CRM copia o arquivo para o
  armazenamento próprio assim que a mensagem chega. O anexo continua
  disponível depois dos dois dias.
- Com o espelhamento desligado, o CRM guarda o link do provedor e aceita que
  ele expire — que é exatamente o que essa opção promete.

Se o download ou a cópia falharem, a mensagem é salva mesmo assim, sem o
anexo. É melhor que uma mensagem perdida.

---

## 6. Quarentena de webhooks

A documentação da UAZAPI deixa o corpo do webhook em aberto. Quando chega
algo que o CRM não reconhece, ele **não adivinha**: guarda uma amostra
limpa em `whatsapp_webhook_quarantine` e responde 200, para o provedor parar
de reenviar algo que nenhuma tentativa resolveria.

A amostra:

- não contém token, segredo, QR, base64 nem bytes de mídia;
- é limitada a 64 KiB;
- é agrupada por impressão digital, então repetições viram um contador em vez
  de linhas novas;
- é apagada **sete dias** depois da última ocorrência.

A limpeza roda no máximo uma vez por dia, a partir dos dois crons
autenticados (`/api/automations/cron` e `/api/flows/cron`) e logo após uma
gravação de quarentena. Assim as linhas somem mesmo que a conta pare de
receber webhooks.

Eventos esperados que o CRM ignora de propósito — mensagem enviada por
este CRM pela API, post de canal/newsletter, status `Queued` — são apenas
confirmados, sem gerar linha de quarentena.

---

## 7. Diagnóstico rápido

| Sintoma                           | Causa provável                       | O que fazer                                       |
| --------------------------------- | ------------------------------------ | ------------------------------------------------- |
| A opção UAZAPI aparece desativada | servidor sem as variáveis            | revisar a seção 1                                 |
| QR não aparece                    | a chamada de conexão falhou          | **Tentar novamente**; o estado fica em "Com erro" |
| QR expira antes de ler            | passaram 2 minutos                   | **Gerar novo QR Code**                            |
| Conectado, mas não chega mensagem | `NEXT_PUBLIC_SITE_URL` não é público | corrigir e reconectar                             |
| Aparece "Sessão pausada"          | a UAZAPI hibernou a sessão           | **Reconectar**                                    |
| Envio falha com erro do provedor  | sessão caiu ou o WhatsApp recusou    | conferir o estado e enviar de novo                |

Um envio que falhou **nunca é repetido sozinho**. Se a resposta ficou
indefinida (tempo esgotado, conexão caída), o CRM registra a falha e espera
você decidir — repetir por conta própria poderia entregar a mesma mensagem
duas vezes para uma pessoa real.

Mais causas e códigos em
[whatsapp-connection-troubleshooting.md](./whatsapp-connection-troubleshooting.md).

---

## 8. Smoke test com número descartável

Esta implementação **não foi validada contra uma instância UAZAPI real** —
não havia ambiente de teste nem número descartável disponíveis. O
comportamento está coberto por testes de contrato e injeção de falhas, o que
não substitui uma execução ao vivo.

Com uma instalação UAZAPI e um número descartável, execute na ordem:

1. criar a instância, ler o QR, recarregar Configurações e conferir o perfil
   conectado;
2. receber e enviar texto e cada tipo de mídia (imagem, vídeo, áudio,
   documento);
3. conferir a progressão de status (enviado → entregue → lido) quando o
   provedor emitir;
4. validar uma automação de texto e um fluxo de texto/mídia;
5. confirmar que Modelos, sincronização e Disparos estão bloqueados, também
   ao chamar as APIs diretamente (devem responder 409);
6. desconectar, reconectar com um QR novo, trocar para a Meta e voltar;
7. conferir `/webhook/errors` na UAZAPI e a tabela de quarentena: nenhum
   evento sem explicação.

Enquanto esses passos não forem executados, registre na entrega:
**Validação UAZAPI ao vivo pendente por ausência de ambiente de teste.**
