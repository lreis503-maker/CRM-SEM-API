import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
} from 'node:fs';

const DIR = 'supabase/migrations';
const OUTDIR = 'supabase/instalacao';

// Big enough that there are few parts, small enough that pasting one
// into the Supabase SQL editor does not freeze a modest browser.
const MAX_PART_BYTES = 78_000;

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const blocks = files.map((file) => ({
  file,
  text: `-- ------------------------------------------------------------
-- ${file}
-- ------------------------------------------------------------

${readFileSync(`${DIR}/${file}`, 'utf8').trim()}
`,
}));

// Pack whole migrations into parts. A migration is never split: half of
// one would fail on its own and leave the database half applied.
const parts = [];
let current = [];
let currentSize = 0;

for (const block of blocks) {
  if (current.length > 0 && currentSize + block.text.length > MAX_PART_BYTES) {
    parts.push(current);
    current = [];
    currentSize = 0;
  }
  current.push(block);
  currentSize += block.text.length;
}
if (current.length > 0) parts.push(current);

rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR, { recursive: true });

const total = parts.length;

parts.forEach((blocks, index) => {
  const n = index + 1;
  const first = blocks[0].file;
  const last = blocks[blocks.length - 1].file;

  const header = `-- ============================================================
-- CRM - BANCO DE DADOS - PARTE ${n} DE ${total}
--
-- Cole ESTE arquivo inteiro no SQL Editor do Supabase e clique
-- em Run. Depois volte e faca o mesmo com a parte ${n < total ? n + 1 : '(acabou)'}.
--
-- IMPORTANTE: rode as partes NA ORDEM, da 1 ate a ${total}.
--
-- Contem: ${first} ate ${last}
--
-- E seguro rodar de novo se voce se perder: tudo aqui usa
-- IF NOT EXISTS ou DROP ... IF EXISTS, entao repetir uma parte
-- nao apaga dados nem quebra nada.
-- ============================================================

`;

  const body = blocks.map((b) => b.text).join('\n\n');
  const name = `parte-${n}-de-${total}.sql`;
  writeFileSync(`${OUTDIR}/${name}`, header + body);

  console.log(
    `${name}: ${blocks.length} migracoes, ${(header + body).length} chars (${first} -> ${last})`
  );
});

const readme = `# Banco de dados - arquivos para colar no Supabase

Sao ${total} arquivos. Abra o **SQL Editor** do seu projeto Supabase e,
**na ordem**, cole o conteudo de cada um e clique em **Run**:

${parts.map((_, i) => `${i + 1}. \`parte-${i + 1}-de-${total}.sql\``).join('\n')}

Espere cada um dizer **Success** antes de ir para o proximo.

Faca isso uma vez so, num projeto Supabase novo e vazio.

---

## Se voce errou a ordem ou rodou duas vezes

Nao tem problema. Todo o SQL aqui usa \`IF NOT EXISTS\` e
\`DROP ... IF EXISTS\`, entao rodar de novo nao apaga dados nem
duplica nada. Se deu erro, volte para a parte 1 e rode todas de novo,
na ordem.

---

## Para quem mantem o projeto

Estes arquivos sao **gerados** a partir de \`supabase/migrations/\`.
Nao edite nada aqui a mao: a fonte da verdade sao as migracoes
numeradas. Depois de criar uma migracao nova, gere estes arquivos
outra vez com o script em \`scripts/gerar-sql-instalacao.mjs\`.
`;

writeFileSync(`${OUTDIR}/LEIA-ME.md`, readme);
console.log(`\nwrote ${OUTDIR}/LEIA-ME.md`);
