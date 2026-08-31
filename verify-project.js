'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const index = read('index.html');
const alias = read('1samuel-test.html');
const quiz = read('quiz.html');
const tracker = read('tracker.js');
const testTracker = read('test-tracker.js');
const auth = read('auth.js');
const build = read('build-site.js');
const worker = read('service-worker.js');
const migration = read('supabase/20260824_secure_scoring.sql');

assert(!/quizVersion:\s*['"][^'"]+-v1['"]/.test(index), 'index.html still references a v1 Samuel quiz.');
assert(index.includes('p_quiz_version: QUIZ_VERSION') && index.includes('p_answers: submittedAnswers'), 'Samuel page must send the secure RPC payload.');
assert(alias.includes('location.replace') && !alias.includes('const TESTS'), '1samuel-test.html must remain a redirect, not a duplicate app.');
assert(build.includes("url.pathname === '/' ? '/index.html'"), 'The generated deployment must serve index.html at /.');
assert(tracker.includes('p_client_attempt_id') && quiz.includes("p_quiz_version:'ioan-v2'") && quiz.includes('p_selected_indices:selected'), 'Ioan tracker/page contract is not v2.');
assert(testTracker.includes("rpc('talant_record_test_attempt'") && testTracker.includes('attempt.p_quiz_version'), 'Samuel tracker RPC contract is inconsistent.');
assert(!auth.includes('toEmail('), 'auth.js references the removed toEmail helper.');
assert(worker.includes("CACHE_NAME = 'cartea-lui-ioan-v2'") && worker.indexOf('fetch(event.request)') < worker.indexOf('caches.match(event.request)'), 'Service worker must be v2 and network-first.');

for (const html of [index, alias]) {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) new Function(match[1]);
  }
}

assert(migration.includes('drop function if exists public.talant_leaderboard(integer);'), 'Secure migration must replace the legacy leaderboard signature safely.');
assert(migration.includes('p_answers jsonb') && migration.includes('p_selected_indices jsonb'), 'Secure migration is missing server-side answer validation.');

const questionSource = read('questions.js').replace(/^\s*(?:const|let|var)\s+QUESTIONS\s*=/m, 'QUESTIONS =');
const questionContext = {};
vm.createContext(questionContext);
vm.runInContext(questionSource, questionContext, { timeout: 1000 });
for (const [index, question] of questionContext.QUESTIONS.entries()) {
  const correct = Array.isArray(question.correct) ? [...question.correct].sort((a, b) => a - b) : [question.correct];
  const row = `('ioan-v2', ${index}, '${JSON.stringify(correct)}'::jsonb)`;
  assert(migration.includes(row), `Secure migration is missing Ioan answer key ${index}.`);
}

const tests = [
  ['samuel1-3-v2', '1samuel-1-3.js'], ['samuel4-6-v2', '1samuel-4-6.js'],
  ['samuel7-9-v2', '1samuel-7-9.js'], ['samuel10-12-v2', '1samuel-10-12.js'],
  ['samuel13-15-v2', '1samuel-13-15.js'], ['samuel16-18-v2', '1samuel-16-18.js'],
  ['samuel19-21-v2', '1samuel-19-21.js'], ['samuel22-24-v2', '1samuel-22-24.js'],
  ['samuel25-27-v2', '1samuel-25-27.js'], ['samuel28-30-v2', '1samuel-28-30.js'],
  ['samuel31-2samuel1-2-v2', '1samuel31-2samuel1-2.js'], ['2samuel3-5-v2', '2samuel-3-5.js'],
  ['2samuel6-8-v2', '2samuel-6-8.js'], ['2samuel9-11-v2', '2samuel-9-11.js'],
  ['2samuel12-14-v2', '2samuel-12-14.js'], ['2samuel15-17-v2', '2samuel-15-17.js'],
  ['2samuel18-20-v2', '2samuel-18-20.js'], ['2samuel21-24-v2', '2samuel-21-24.js'],
];
let testKeyCount = 0;
for (const [version, file] of tests) {
  const data = require(path.join(__dirname, 'data', file));
  for (const section of data.sections) {
    const items = section.type === 'match' ? section.left : section.items;
    items.forEach((item, itemIndex) => {
      const answer = section.type === 'multi' ? [...item.correct].sort() : item.correct;
      const escaped = JSON.stringify(answer).replace(/'/g, "''");
      const row = `('${version}', '${section.id}', ${itemIndex}, '${escaped}'::jsonb, ${section.points})`;
      assert(migration.includes(row), `Secure migration is missing ${version}/${section.id}/${itemIndex}.`);
      testKeyCount++;
    });
  }
}

console.log(`Validated canonical pages, RPC contracts, and ${questionContext.QUESTIONS.length + testKeyCount} server answer keys.`);
