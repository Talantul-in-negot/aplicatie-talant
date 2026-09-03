'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SAMUEL_TESTS, samuelAnswerKeys, ioanAnswerKeys } = require('./scripts/quiz-catalog.js');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const index = read('index.html');
const alias = read('1samuel-test.html');
const quiz = read('quiz.html');
const tracker = read('tracker.js');
const testTracker = read('test-tracker.js');
const auth = read('auth.js');
const build = read('build-site.js');
const worker = read('service-worker.js');
const config = read('config.js');
const pagesConfig = read('_config.yml');
const migration = read('supabase/20260824_secure_scoring.sql');
const hardening = read('supabase/20260903_harden_identity_groups_attempts.sql');
const manifest = read('supabase/migrations.txt');

// ── Rute și contracte RPC ──────────────────────────────────────────────────
assert(!/quizVersion:\s*['"][^'"]+-v1['"]/.test(index), 'index.html still references a v1 Samuel quiz.');
assert(index.includes('p_quiz_version: QUIZ_VERSION') && index.includes('p_answers: submittedAnswers'), 'Samuel page must send the secure RPC payload.');
assert(alias.includes('location.replace') && !alias.includes('const TESTS'), '1samuel-test.html must remain a redirect, not a duplicate app.');
assert(build.includes("url.pathname === '/' ? '/index.html'"), 'The generated deployment must serve index.html at /.');
assert(tracker.includes('p_client_attempt_id') && quiz.includes("p_quiz_version:'ioan-v2'") && quiz.includes('p_selected_indices:selected'), 'Ioan tracker/page contract is not v2.');
assert(testTracker.includes("rpc('talant_record_test_attempt'") && testTracker.includes('attempt.p_quiz_version'), 'Samuel tracker RPC contract is inconsistent.');
assert(!auth.includes('toEmail('), 'auth.js references the removed toEmail helper.');

// Un id necunoscut trebuie să ducă la selector, nu la un id inexistent.
assert(!/if \(!TESTS\[id\]\) id = /.test(index), 'startTest must not fall back to a hard-coded test id.');
assert(/if \(!TESTS\[id\]\) \{ showSelector/.test(index), 'startTest must fall back to the selector for unknown ids.');

// ── Identitatea contului nu poate alege grupa ──────────────────────────────
assert(/if \(name\.includes\('@'\)\)[\s\S]{0,200}throw new Error/.test(auth),
  'signUp must reject full email addresses: the email domain used to decide the leaderboard group.');
assert(auth.includes('accountLocalPart'), 'auth.js must build signup and login addresses through one normaliser.');
assert(/email: accountLocalPart\(name\) \+ DOMAIN/.test(auth), 'signUp must derive the address from the username only.');

// ── Migrarea de întărire este înregistrată și își păstrează garanțiile ─────
assert(manifest.includes('20260903_harden_identity_groups_attempts.sql'),
  'The hardening migration is not listed in supabase/migrations.txt, so it will never be applied.');
assert(hardening.includes('create table if not exists public.talant_group_members'),
  'The hardening migration must introduce the server-side group table.');
assert(/create or replace function public\.talant_user_group\(\)[\s\S]{0,400}talant_group_members/.test(hardening),
  'talant_user_group must read the server-side table, not the email domain.');
assert(!/talant_user_group[\s\S]{0,400}talant_church_domains/.test(hardening),
  'talant_user_group must no longer consult talant_church_domains at runtime.');
assert(hardening.includes('public.talant_display_name()') && hardening.includes('talant_profiles_name_key'),
  'The hardening migration must pin display names and keep them unique.');
for (const fn of ['talant_recalculate_own_score', 'talant_record_attempt', 'talant_test_recalculate_own_score', 'talant_record_test_attempt']) {
  const body = new RegExp(`create or replace function public\\.${fn}\\(([\\s\\S]*?)\\n\\$\\$;`).exec(hardening);
  assert(body, `The hardening migration must redefine ${fn}.`);
  assert(!/auth\.jwt\(\) -> 'user_metadata'/.test(body[1]),
    `${fn} still reads the display name from user_metadata, which the account can rewrite itself.`);
}
assert(/limit public\.talant_scored_attempts\(p_quiz_version\)/.test(hardening),
  'talant_test_recalculate_own_score must only score the capped attempts.');

// ── Baremele nu sunt publicate de GitHub Pages ─────────────────────────────
for (const excluded of ['supabase/', 'scripts/', 'db/', 'data/*.pdf']) {
  assert(pagesConfig.includes(`- ${excluded}`),
    `_config.yml must exclude ${excluded} from GitHub Pages — the site is published from the repository root.`);
}

// ── Dependența externă este fixată și verificată ───────────────────────────
const SUPABASE_ORIGIN = /SUPABASE_URL\s*=\s*["']([^"']+)/.exec(config)?.[1];
assert(SUPABASE_ORIGIN, 'config.js must define SUPABASE_URL.');
for (const [name, html] of [['index.html', index], ['quiz.html', quiz]]) {
  const tag = /<script src="(https:\/\/cdn\.jsdelivr\.net[^"]+)"([\s\S]{0,300}?)><\/script>/.exec(html);
  assert(tag, `${name} must load supabase-js from the pinned CDN URL.`);
  assert(/@supabase\/supabase-js@\d+\.\d+\.\d+\//.test(tag[1]), `${name} pins supabase-js to a floating version.`);
  assert(/integrity="sha384-[A-Za-z0-9+/=]+"/.test(tag[2]), `${name} loads supabase-js without a subresource integrity hash.`);
  assert(/crossorigin="anonymous"/.test(tag[2]), `${name} needs crossorigin="anonymous" for integrity to be enforced.`);

  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert(csp, `${name} must carry a Content-Security-Policy meta tag (GitHub Pages cannot send headers).`);
  assert(csp[1].includes(`connect-src 'self' ${SUPABASE_ORIGIN}`), `${name} CSP connect-src does not match SUPABASE_URL in config.js.`);
  assert(csp[1].includes("object-src 'none'") && csp[1].includes("base-uri 'self'"), `${name} CSP is missing object-src/base-uri.`);
}
assert(build.includes('frame-ancestors') && build.includes('x-content-type-options'),
  'build-site.js must send the security headers the meta tag cannot express.');

// ── Service worker ─────────────────────────────────────────────────────────
const cacheName = /CACHE_NAME = '([^']+)'/.exec(worker)?.[1];
assert(cacheName && cacheName !== 'cartea-lui-ioan-v2', 'Bump CACHE_NAME so clients drop the previous cache.');
assert(worker.includes("'index.html'"), 'The service worker must precache index.html, the primary page.');
assert(worker.indexOf('fetch(event.request)') < worker.indexOf('caches.match(event.request)'), 'Service worker must stay network-first.');

// ── Scripturile inline din pagini rămân sintactic valide ───────────────────
for (const html of [index, alias, quiz]) {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) new Function(match[1]);
  }
}

// ── Catalogul de teste este identic cu cel din pagină ──────────────────────
const pageTests = [...index.matchAll(/'([^']+)':\s*\{\s*quizVersion:\s*'([^']+)',\s*label:\s*'([^']*)'/g)]
  .map(([, testId, version, label]) => ({ testId, version, label }));
assert.strictEqual(pageTests.length, SAMUEL_TESTS.length,
  `index.html lists ${pageTests.length} tests but scripts/quiz-catalog.js lists ${SAMUEL_TESTS.length}.`);
pageTests.forEach((page, i) => {
  const known = SAMUEL_TESTS[i];
  assert.deepStrictEqual({ testId: page.testId, version: page.version, label: page.label },
    { testId: known.testId, version: known.version, label: known.label },
    `Test #${i} differs between index.html and scripts/quiz-catalog.js.`);
});

// ── Cheile de răspuns: potrivire exactă, fără lipsuri, dubluri sau resturi ──
function parseRows(sql, pattern) {
  const rows = new Map();
  for (const match of sql.matchAll(pattern)) {
    const key = match.slice(1, match.length - 1).join(' ');
    assert(!rows.has(key), `Duplicate answer-key row in the migration: ${match[0].trim()}`);
    rows.set(key, match[match.length - 1]);
  }
  return rows;
}

const ioanInMigration = parseRows(migration, /\('(ioan-v2)', (\d+), '([^']*)'::jsonb\)/g);
const ioanExpected = new Map(ioanAnswerKeys().map(({ questionId, indices }) =>
  [`ioan-v2 ${questionId}`, JSON.stringify(indices)]));
assert.deepStrictEqual(new Set(ioanInMigration.keys()), new Set(ioanExpected.keys()),
  'The Ioan answer keys in the migration do not match questions.js one-for-one.');
for (const [key, expected] of ioanExpected) {
  assert.strictEqual(ioanInMigration.get(key), expected, `Wrong Ioan answer key for ${key.replace(' ', '/')}.`);
}

const samuelInMigration = parseRows(migration, /\('([a-z0-9-]+-v2)', '([IVX]+)', (\d+), '((?:[^']|'')*)'::jsonb, (\d+)\)/g);
const samuelExpected = new Map(samuelAnswerKeys().map(({ version, sectionId, itemIndex, answer, points }) =>
  [`${version} ${sectionId} ${itemIndex} ${JSON.stringify(answer).replace(/'/g, "''")}`, String(points)]));
const samuelActual = new Map([...samuelInMigration].map(([key, points]) => [key, points]));
assert.deepStrictEqual(new Set(samuelActual.keys()), new Set(samuelExpected.keys()),
  'The Samuel answer keys in the migration do not match the data/ files one-for-one.');
for (const [key, expected] of samuelExpected) {
  assert.strictEqual(samuelActual.get(key), expected, `Wrong point value for ${key.split(' ').slice(0, 3).join('/')}.`);
}

console.log(`Validated canonical pages, RPC contracts, published-file exclusions, pinned CDN dependency, and ${ioanExpected.size + samuelExpected.size} server answer keys.`);
