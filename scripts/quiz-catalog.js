'use strict';

/* Sursa unică de adevăr pentru testele Samuel: id-ul din URL (?test=...),
   versiunea folosită la scorare și fișierul de date. index.html, generatorul
   de migrări și verificările din npm test citesc toate de aici, deci nu pot
   să divergă. verify-project.js confirmă că lista de mai jos este identică
   cu obiectul TESTS din index.html. */
const PROJECT_ROOT = require('path').join(__dirname, '..');

const SAMUEL_TESTS = [
  { testId: 'samuel1-3', version: 'samuel1-3-v2', file: '1samuel-1-3.js', label: '1 Samuel 1-3' },
  { testId: 'samuel4-6', version: 'samuel4-6-v2', file: '1samuel-4-6.js', label: '1 Samuel 4-6' },
  { testId: 'samuel7-9', version: 'samuel7-9-v2', file: '1samuel-7-9.js', label: '1 Samuel 7-9' },
  { testId: 'samuel10-12', version: 'samuel10-12-v2', file: '1samuel-10-12.js', label: '1 Samuel 10-12' },
  { testId: 'samuel13-15', version: 'samuel13-15-v2', file: '1samuel-13-15.js', label: '1 Samuel 13-15' },
  { testId: 'samuel16-18', version: 'samuel16-18-v2', file: '1samuel-16-18.js', label: '1 Samuel 16-18' },
  { testId: 'samuel19-21', version: 'samuel19-21-v2', file: '1samuel-19-21.js', label: '1 Samuel 19-21' },
  { testId: 'samuel22-24', version: 'samuel22-24-v2', file: '1samuel-22-24.js', label: '1 Samuel 22-24' },
  { testId: 'samuel25-27', version: 'samuel25-27-v2', file: '1samuel-25-27.js', label: '1 Samuel 25-27' },
  { testId: 'samuel28-30', version: 'samuel28-30-v2', file: '1samuel-28-30.js', label: '1 Samuel 28-30' },
  { testId: 'samuel31-2samuel1-2', version: 'samuel31-2samuel1-2-v2', file: '1samuel31-2samuel1-2.js', label: '1 Samuel 31; 2 Samuel 1-2' },
  { testId: '2samuel3-5', version: '2samuel3-5-v2', file: '2samuel-3-5.js', label: '2 Samuel 3-5' },
  { testId: '2samuel6-8', version: '2samuel6-8-v2', file: '2samuel-6-8.js', label: '2 Samuel 6-8' },
  { testId: '2samuel9-11', version: '2samuel9-11-v2', file: '2samuel-9-11.js', label: '2 Samuel 9-11' },
  { testId: '2samuel12-14', version: '2samuel12-14-v2', file: '2samuel-12-14.js', label: '2 Samuel 12-14' },
  { testId: '2samuel15-17', version: '2samuel15-17-v2', file: '2samuel-15-17.js', label: '2 Samuel 15-17' },
  { testId: '2samuel18-20', version: '2samuel18-20-v2', file: '2samuel-18-20.js', label: '2 Samuel 18-20' },
  { testId: '2samuel21-24', version: '2samuel21-24-v2', file: '2samuel-21-24.js', label: '2 Samuel 21-24' },
];

/* Cheile de răspuns server-side, derivate din aceleași fișiere de date pe care
   le încarcă pagina. Ordinea este stabilă (test, secțiune, item) — generatorul
   de migrări și verificarea de drift depind de ea. */
function samuelAnswerKeys(root) {
  const path = require('path');
  root = path.resolve(root || PROJECT_ROOT);
  const keys = [];
  for (const { version, file } of SAMUEL_TESTS) {
    const data = require(path.join(root, 'data', file));
    for (const section of data.sections) {
      const items = section.type === 'match' ? section.left : section.items;
      items.forEach((item, itemIndex) => {
        const answer = section.type === 'multi' ? [...item.correct].sort() : item.correct;
        keys.push({ version, sectionId: section.id, itemIndex, answer, points: section.points });
      });
    }
  }
  return keys;
}

function ioanAnswerKeys(root) {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  root = path.resolve(root || PROJECT_ROOT);
  const source = fs.readFileSync(path.join(root, 'questions.js'), 'utf8')
    .replace(/^\s*(?:const|let|var)\s+QUESTIONS\s*=/m, 'QUESTIONS =');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context, { timeout: 5000 });
  return context.QUESTIONS.map((question, questionId) => ({
    questionId,
    indices: Array.isArray(question.correct) ? [...question.correct].sort((a, b) => a - b) : [question.correct],
  }));
}

module.exports = { PROJECT_ROOT, SAMUEL_TESTS, samuelAnswerKeys, ioanAnswerKeys };
