# Banco de dados - arquivos para colar no Supabase

Sao 4 arquivos. Abra o **SQL Editor** do seu projeto Supabase e,
**na ordem**, cole o conteudo de cada um e clique em **Run**:

1. `parte-1-de-4.sql`
2. `parte-2-de-4.sql`
3. `parte-3-de-4.sql`
4. `parte-4-de-4.sql`

Espere cada um dizer **Success** antes de ir para o proximo.

Faca isso uma vez so, num projeto Supabase novo e vazio.

---

## Se voce errou a ordem ou rodou duas vezes

Nao tem problema. Todo o SQL aqui usa `IF NOT EXISTS` e
`DROP ... IF EXISTS`, entao rodar de novo nao apaga dados nem
duplica nada. Se deu erro, volte para a parte 1 e rode todas de novo,
na ordem.

---

## Para quem mantem o projeto

Estes arquivos sao **gerados** a partir de `supabase/migrations/`.
Nao edite nada aqui a mao: a fonte da verdade sao as migracoes
numeradas. Depois de criar uma migracao nova, gere estes arquivos
outra vez com o script em `scripts/gerar-sql-instalacao.mjs`.
