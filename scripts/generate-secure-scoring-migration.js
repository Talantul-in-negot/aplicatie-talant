'use strict';

/* Regenerează supabase/20260824_secure_scoring.sql din aceleași fișiere de date
   pe care le încarcă browserul, ca migrarea aplicată să nu poată devia de
   conținutul testelor.

   Migrarea 20260824 este deja aplicată în producție, deci fișierul NU trebuie
   modificat: rulat fără argumente, generatorul verifică doar că regenerarea
   produce exact octeții din repo (`--check`, folosit de npm test). Cheile noi
   sau corectate se adaugă într-o migrare nouă, nu prin editarea acesteia.

   Utilizare:
     node scripts/generate-secure-scoring-migration.js --check   (implicit)
     node scripts/generate-secure-scoring-migration.js --write   (rescrie fișierul)
*/

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT, samuelAnswerKeys, ioanAnswerKeys } = require('./quiz-catalog.js');

const TARGET = path.join(PROJECT_ROOT, 'supabase', '20260824_secure_scoring.sql');
const TEMPLATE = path.join(__dirname, 'secure-scoring-template.sql');
const EOL = '\r\n';

// Literal SQL pentru un jsonb: dublăm apostrofurile din text, ca o ghilimea
// dintr-un răspuns să nu poată închide literalul.
const jsonbLiteral = value => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;

function insertBlock(header, rows, conflict) {
  return [header, ...rows.map((row, i) => row + (i === rows.length - 1 ? '' : ',')), conflict].join(EOL);
}

function build() {
  const template = fs.readFileSync(TEMPLATE, 'utf8');

  const ioanRows = ioanAnswerKeys().map(({ questionId, indices }) =>
    `('ioan-v2', ${questionId}, ${jsonbLiteral(indices)})`);
  const samuelRows = samuelAnswerKeys().map(({ version, sectionId, itemIndex, answer, points }) =>
    `('${version}', '${sectionId}', ${itemIndex}, ${jsonbLiteral(answer)}, ${points})`);

  const ioanBlock = insertBlock(
    'insert into public.talant_quiz_answer_keys (quiz_version, question_id, correct_indices) values',
    ioanRows,
    'on conflict (quiz_version, question_id) do update set correct_indices = excluded.correct_indices;');
  const samuelBlock = insertBlock(
    'insert into public.talant_test_answer_keys (quiz_version, section_id, item_index, correct_answer, points) values',
    samuelRows,
    'on conflict (quiz_version, section_id, item_index) do update set correct_answer = excluded.correct_answer, points = excluded.points;');

  return template + ioanBlock + EOL + EOL + samuelBlock + EOL + EOL + 'commit;' + EOL;
}

const generated = build();
if (process.argv.includes('--write')) {
  fs.writeFileSync(TARGET, generated);
  console.log(`Wrote ${path.relative(PROJECT_ROOT, TARGET)} (${generated.length} bytes).`);
} else {
  const current = fs.readFileSync(TARGET, 'utf8');
  if (current !== generated) {
    console.error('supabase/20260824_secure_scoring.sql no longer matches the question data it was generated from.');
    console.error('The applied migration must not change; add corrected keys in a new migration instead.');
    process.exit(1);
  }
  console.log(`Answer-key migration matches the question data (${generated.length} bytes).`);
}
