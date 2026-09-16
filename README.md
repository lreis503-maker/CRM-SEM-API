# wacrm — CRM para WhatsApp

> CRM com hospedagem própria para WhatsApp®: caixa de entrada compartilhada,
> contatos, funis de vendas, disparos e automações visuais.
> Crie sua cópia, personalize a marca e hospede onde preferir.

<p align="center">
  <a href="https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST">
    <img src="./.github/assets/hostinger-deploy.png" alt="Publique seu aplicativo Node.js com um clique na Hostinger" width="900">
  </a>
</p>

[![Licença: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![CI](https://github.com/ArnasDon/wacrm/actions/workflows/ci.yml/badge.svg)](https://github.com/ArnasDon/wacrm/actions/workflows/ci.yml)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)
[![Estrelas](https://img.shields.io/github/stars/ArnasDon/wacrm?style=social)](https://github.com/ArnasDon/wacrm/stargazers)

O site de apresentação e os guias de hospedagem ficam no repositório
[ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site)
([wacrm.tech](https://wacrm.tech)). Este repositório contém o aplicativo:
clone-o ou crie uma cópia para executar seu próprio CRM.

## Funcionalidades incluídas

- **Duas formas de conectar o WhatsApp**: a API oficial da Meta, com todos os
  recursos, ou a **UAZAPI por QR Code**, para conversas individuais com texto e
  mídia. Cada conta escolhe uma; o histórico permanece ao trocar. Veja
  [docs/uazapi.md](./docs/uazapi.md).
- **Caixa de entrada compartilhada** com a API oficial do WhatsApp Business:
  vários atendentes no mesmo número, atribuição de conversas, status e notas.
- **Contatos, etiquetas e campos personalizados**, com importação de CSV e
  identificação de contatos duplicados.
- **Funis de vendas** em quadro Kanban, com negócios vinculados às conversas.
- **Disparos** com modelos aprovados pela Meta, acompanhamento de entrega e
  leitura e substituição de variáveis para cada destinatário.
- **Automações visuais** acionadas por mensagens recebidas, novos contatos,
  palavras-chave ou agendamentos. Incluem condições, esperas, etiquetas e webhooks.
- **Assistente de respostas com IA** usando sua própria chave da OpenAI ou
  Anthropic, armazenada de forma criptografada. Você paga diretamente ao provedor,
  sem taxa de IA por atendente. Sugira respostas na caixa de entrada ou ative um
  agente de resposta automática, com limite por conversa e transferência para
  atendimento humano. A **base de conhecimento** permite responder a partir das
  suas perguntas frequentes, políticas e documentos. A busca usa pesquisa textual
  do Postgres ou busca semântica com pgvector quando há uma chave de vetorização.
- **Painel em tempo real** com tempo de resposta, volume diário, valor dos
  negócios e atividade recente dos módulos.
- **Contas de equipe** com convites por link, funções de proprietário,
  administrador, atendente e visualizador e transferência de propriedade.
  Os dados pertencem à conta, permitindo que toda a equipe use a mesma caixa de entrada.
  O uso individual também funciona sem configuração de equipe.
- **Gerenciamento de conta**: e-mail, senha, foto de perfil e encerramento de todas as sessões.
- **API REST pública** em `/api/v1`, com chaves revogáveis e permissões
  específicas. Consulte [a documentação da API](./docs/public-api.md).
- **Servidor MCP** para usar o CRM com Claude, Cursor e outros assistentes pelo
  [Model Context Protocol](https://modelcontextprotocol.io). O acesso é somente
  leitura por padrão; as gravações precisam ser ativadas. Consulte
  [o guia MCP](./docs/mcp.md) e [o servidor](./mcp-server).

## Por que criar sua própria cópia?

Este projeto é um modelo para personalização. Criar uma cópia permite:

- **Controlar tudo**: código, projeto Supabase, domínio e dados, sem depender de
  uma plataforma SaaS ou pagar por usuário.
- **Personalizar a experiência**: adicione campos, remova módulos e adapte o
  visual. A base usa Next.js, Supabase e Tailwind.
- **Começar com uma hospedagem gerenciada**: a
  [Hostinger](https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST)
  permite publicar uma cópia usando Node.js gerenciado, sem configurar Docker,
  Kubernetes ou uma equipe de infraestrutura.
- **Usar os controles de segurança do projeto**: criptografia AES-256-GCM para
  tokens, RLS nas tabelas, verificação HMAC dos webhooks, CSP, limites de
  solicitações e verificações de tipos e compilação na integração contínua.

É um CRM pronto para executar e adaptar ao seu negócio.

## Início rápido

Requisito: Node.js 20 ou superior.

```bash
# Primeiro, crie uma cópia do repositório no GitHub.
git clone https://github.com/<seu-usuario>/wacrm.git
cd wacrm
npm install
cp .env.local.example .env.local
# Preencha .env.local com as credenciais do Supabase e da Meta.
npm run dev
```

No PowerShell, copie a configuração com:

```powershell
Copy-Item .env.local.example .env.local
```

Abra [http://localhost:3000](http://localhost:3000). Você será encaminhado para
`/login` ou para `/dashboard`, se já estiver conectado.

A interface usa **português brasileiro por padrão**, com datas, meses e números
no formato brasileiro. A configuração de idioma em `.env.local` é:

```dotenv
NEXT_PUBLIC_APP_LOCALE=pt-BR
```

`pt` e `pt_BR` também selecionam o português brasileiro. Os catálogos
`en`, `ko` e `es` continuam disponíveis em `messages/`.
Valores desconhecidos usam português. Reinicie o servidor de desenvolvimento
após alterar a variável; em produção, gere uma nova compilação.

Para importar contatos, o CSV aceita os cabeçalhos `telefone`, `nome`,
`email`, `empresa` e `etiquetas`. A coluna de telefone é obrigatória
e deve conter números internacionais no formato E.164, como `+5511999999999`.
Os cabeçalhos em inglês continuam aceitos.

Para executar em contêineres, consulte [o guia Docker](./docs/docker.md).

## Publicação na Hostinger

<p align="center">
  <a href="https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST">
    <img src="./.github/assets/hostinger-deploy.png" alt="Publique seu aplicativo Node.js na Hostinger" width="1000">
  </a>
</p>

O projeto inclui orientações de publicação na
[Hostinger](https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST).
Consulte os recursos e as condições do plano escolhido antes de contratar.

| Recurso | Utilidade |
| --- | --- |
| Publicação pelo Git | Conecte sua cópia do GitHub e publique as alterações da branch `main`. |
| Node.js gerenciado | Execute o Next.js sem administrar processos e proxies manualmente. |
| HTTPS e domínio | Configure o endereço público e o HTTPS exigido pelo webhook do WhatsApp. |
| CDN e cache | Distribua os arquivos estáticos e melhore o carregamento do painel. |
| Variáveis e registros no hPanel | Configure as credenciais do Supabase e da Meta e consulte os registros da aplicação. |
| Proteção e cópias de segurança | Confira os recursos de proteção e backup incluídos no plano. |
| Custo da hospedagem | Compare o plano gerenciado com uma VPS e considere o Supabase separadamente. |
| Suporte | Consulte os canais de atendimento e os idiomas disponíveis. |

Para publicar:

1. Crie uma cópia deste repositório no GitHub.
2. No hPanel, abra a área de sites, escolha a criação de um aplicativo Node.js
   e conecte sua cópia do repositório.
3. Configure as variáveis do Supabase e da Meta e
   `NEXT_PUBLIC_APP_LOCALE=pt-BR`.
4. Envie as alterações para `main` e acompanhe a compilação e a publicação.

Consulte [o guia de publicação na Hostinger](https://wacrm.tech/docs/deployment-hostinger).

O projeto tem licença MIT e também pode ser executado na Vercel, Railway ou em
uma VPS com Node.js. A Hostinger é uma opção de hospedagem, não um requisito.

## Documentação

Os guias completos de hospedagem, configuração do Supabase, migrações e API do
WhatsApp ficam em [wacrm.tech/docs](https://wacrm.tech/docs), com o código do site
em [ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site).

- [Primeiros passos](https://wacrm.tech/docs/getting-started)
- [Configuração do Supabase](https://wacrm.tech/docs/supabase-setup)
- [Configuração do WhatsApp](https://wacrm.tech/docs/whatsapp-setup)
- [Variáveis de ambiente](https://wacrm.tech/docs/environment-variables)
- [Publicação na Hostinger](https://wacrm.tech/docs/deployment-hostinger)
- [Arquitetura](https://wacrm.tech/docs/architecture)
- [Solução de problemas](https://wacrm.tech/docs/troubleshooting)
- [Conexão pela UAZAPI (QR Code)](./docs/uazapi.md): como habilitar no servidor,
  conectar pelo QR, o que fica indisponível e como trocar de provedor.
- [Problemas de conexão com o WhatsApp](./docs/whatsapp-connection-troubleshooting.md):
  significado dos erros ao salvar a configuração e códigos para informar ao suporte da Meta.
- [Várias contas do WhatsApp Business](./docs/multi-waba.md): uso de um ou vários
  aplicativos da Meta e lista de segredos em `META_APP_SECRET`.
- [API pública](./docs/public-api.md)
- [Integração MCP](./docs/mcp.md)

## Tecnologias

- **Aplicação**: Next.js 16 com App Router, React 19, TypeScript e Tailwind v4.
- **Dados**: Supabase com Postgres, autenticação, armazenamento e RLS.
- **WhatsApp**: API de Nuvem oficial do WhatsApp Business da Meta, com a UAZAPI como alternativa opcional por QR Code.

## Verificações de desenvolvimento

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Contribuições

O fluxo principal deste modelo é criar uma cópia, personalizar e publicar.
Relatos de falhas e problemas de segurança são bem-vindos. Funcionalidades
específicas do seu negócio podem ficar na sua própria cópia. Consulte
[CONTRIBUTING.md](./CONTRIBUTING.md) e [as orientações de segurança](./.github/SECURITY.md).

## Licença

[MIT](./LICENSE). Crie sua cópia, personalize a marca e hospede.
