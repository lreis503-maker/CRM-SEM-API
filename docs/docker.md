# Executar com Docker

O projeto inclui um `Dockerfile` em várias etapas, com a saída independente
do Next.js e execução com usuário sem privilégios de administrador.
O `docker-compose.yml` define um serviço `app`. O Supabase é externo:
configure o endereço do seu projeto hospedado ou local nas variáveis de ambiente.
Não há um contêiner de banco de dados nesta configuração.

## Início rápido

1. Copie o arquivo de exemplo e preencha as credenciais:

   ```bash
   cp .env.local.example .env.local
   ```

   No PowerShell:

   ```powershell
   Copy-Item .env.local.example .env.local
   ```

2. Compile e inicie os contêineres. O parâmetro `--env-file` é necessário,
   pois o Compose lê `.env` por padrão, enquanto este projeto usa `.env.local`:

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. Acesse [http://localhost:3000](http://localhost:3000). Para publicar em outra
   porta, defina `HOST_PORT=8080` em `.env.local`.

Use `HOST_PORT` para alterar a porta externa. A variável `PORT` controla a
porta interna do servidor e é fixada em 3000 pelo Compose para corresponder ao
mapeamento e à verificação de saúde.

## Variáveis de compilação e execução

- As variáveis `NEXT_PUBLIC_*` são incorporadas ao código do navegador durante
  a compilação. O Compose as transmite como argumentos de compilação. Ao alterá-las,
  execute novamente `docker compose --env-file .env.local up --build -d`.
  O idioma padrão é `NEXT_PUBLIC_APP_LOCALE=pt-BR`. Os valores `pt`,
  `en`, `ko` e `es` também são aceitos.
- As demais variáveis, como `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` e
  `META_APP_SECRET`, são lidas durante a execução por meio de `env_file`.
  Elas não ficam incorporadas à imagem. Para recarregar alterações no arquivo,
  recrie o serviço com `docker compose --env-file .env.local up -d --force-recreate`.

## Docker sem Compose

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-chave-anonima \
  --build-arg NEXT_PUBLIC_APP_LOCALE=pt-BR \
  -t wacrm .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 wacrm
```

## Observações

- As migrações de `supabase/migrations/` não são executadas pelo contêiner.
  Aplique-as ao seu projeto Supabase antes de usar o aplicativo.
- Os anexos recebidos são copiados para o armazenamento `chat-media` do Supabase.
  Isso permite mantê-los após a remoção da mídia pela Meta. Acompanhe a cota de
  armazenamento do projeto. Você pode desativar a cópia em Configurações →
  WhatsApp → Armazenamento de anexos. Arquivos recebidos sem cópia deixam de estar
  disponíveis quando a Meta remove a mídia. Arquivos acima de 16 MB não são copiados.
- O contêiner não executa agendamentos internos. Para etapas de espera de
  automações e fluxos, configure um agendador externo para chamar
  `GET /api/automations/cron` e `GET /api/flows/cron`. Envie o segredo de
  `AUTOMATION_CRON_SECRET` no cabeçalho `x-cron-secret`.
  Esses endpoints retornam 503 enquanto a variável não estiver configurada.
