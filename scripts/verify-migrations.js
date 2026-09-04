'use strict';

/* Aplică toate migrările pe o bază Postgres de unică folosință și verifică
   garanțiile pe care se bazează clasamentul:

     - numele afișat se fixează o dată și nu mai poate fi schimbat din browser;
     - două conturi nu pot împărți același nume în clasament;
     - grupa nu poate fi aleasă de utilizator prin domeniul emailului;
     - doar primele N încercări intră în scor.

   Rulare:
     npm run test:db                       (pornește singur un container Docker)
     TALANT_TEST_DB_URL=... npm run test:db  (folosește o bază existentă, ex. în CI)

   Nu atinge niciodată baza de producție: refuză orice URL care nu este local. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PROJECT_ROOT } = require('./quiz-catalog.js');

const CONTAINER = 'talant-migration-check';
const DB_URL = process.env.TALANT_TEST_DB_URL || null;

if (DB_URL && !/@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(DB_URL)) {
  throw new Error('TALANT_TEST_DB_URL must point at a local throwaway database, never production.');
}

const MIGRATIONS = [
  '20260821_talant_scoring.sql',
  '20260821_fix_attempt_id.sql',
  '20260821_one_point_and_display_name.sql',
  '20260822_talant_test_scoring.sql',
  '20260822b_fix_test_attempt_id.sql',
  '20260822c_fix_test_display_name.sql',
  '20260823_talant_test_church.sql',
  '20260824_secure_scoring.sql',
  '20260903_harden_identity_groups_attempts.sql',
  '20260904_test_best_of_all_attempts.sql',
  '20260904b_profile_name_unique_per_group.sql',
  '20260904c_display_name_email_fallback.sql',
  '20260904d_test_domain_ci_group.sql',
  '20260904e_test_qa_group_not_ci.sql',
];

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...options });
}

function haveDocker() {
  return docker(['info']).status === 0;
}

function startContainer() {
  docker(['rm', '-f', CONTAINER]);
  const run = docker(['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=talant', 'postgres:16']);
  if (run.status !== 0) throw new Error(`Could not start Postgres: ${run.stderr || run.stdout}`);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const probe = docker(['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'talant', '-tAc', 'select 1']);
    if (probe.status === 0 && probe.stdout.trim() === '1') return;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},700)']);
  }
  throw new Error('Postgres did not become ready in time.');
}

// Fiecare apel este o sesiune psql nouă, deci claims-urile JWT trebuie setate
// în același script cu apelurile pe care le testează.
function sql(script, { expectFailure = false } = {}) {
  const args = DB_URL
    ? ['psql', DB_URL]
    : ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'talant'];
  const command = DB_URL ? 'psql' : 'docker';
  const argv = DB_URL ? args.slice(1) : args;
  const result = spawnSync(command, [...argv, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-tA', '-f', '-'],
    { encoding: 'utf8', input: script });
  const failed = result.status !== 0;
  if (failed && !expectFailure) {
    throw new Error(`SQL failed:\n${script.slice(0, 400)}\n---\n${result.stderr}`);
  }
  if (!failed && expectFailure) throw new Error(`Expected SQL to fail but it succeeded:\n${script.slice(0, 400)}`);
  return { ok: !failed, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() };
}

const value = script => sql(script).out;

function applyMigrations() {
  sql(fs.readFileSync(path.join(__dirname, 'auth-shim.sql'), 'utf8'));
  // Conturile existente înainte de întărire: cel de biserică trebuie păstrat în
  // grupa lui de către popularea unică din migrare.
  sql(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('11111111-1111-4111-8111-111111111111', 'ana@talant.app', '{"username":"Ana"}'),
      ('22222222-2222-4222-8222-222222222222', 'bogdan@talant.app', '{"username":"Bogdan"}'),
      ('33333333-3333-4333-8333-333333333333', 'vechi@test.com', '{"username":"Vechi"}'),
      ('44444444-4444-4444-8444-444444444444', 'nou@test.com', '{"username":"Nou"}'),
      ('55555555-5555-4555-8555-555555555555', 'ci@talant.app', '{"username":"Ci"}')
    on conflict (id) do nothing;`);

  for (const file of MIGRATIONS) {
    const body = fs.readFileSync(path.join(PROJECT_ROOT, 'supabase', file), 'utf8');
    if (file === '20260903_harden_identity_groups_attempts.sql') {
      // Contul „nou@test.com" se înregistrează abia după întărire, deci nu
      // trebuie să intre în grupa bisericii — îl ascundem de popularea unică.
      sql(`delete from auth.users where email = 'nou@test.com';`);
    }
    sql(body);
    if (file === '20260903_harden_identity_groups_attempts.sql') {
      sql(`insert into auth.users (id, email, raw_user_meta_data) values
        ('44444444-4444-4444-8444-444444444444', 'nou@test.com', '{"username":"Nou"}');`);
    }
  }
}

const CHECKS = [];
const check = (name, fn) => CHECKS.push([name, fn]);

const answersFor = (version, root = PROJECT_ROOT) => {
  const { SAMUEL_TESTS } = require('./quiz-catalog.js');
  const entry = SAMUEL_TESTS.find(t => t.version === version);
  const data = require(path.join(root, 'data', entry.file));
  const answers = {};
  let total = 0;
  for (const section of data.sections) {
    const items = section.type === 'match' ? section.left : section.items;
    answers[section.id] = {};
    items.forEach((item, i) => {
      answers[section.id][i] = section.type === 'multi' ? [...item.correct].sort() : item.correct;
      total += section.points;
    });
  }
  return { answers, total };
};

const VERSION = 'samuel1-3-v2';
const { answers: PERFECT, total: MAX_POINTS } = answersFor(VERSION);
const EMPTY = Object.fromEntries(Object.keys(PERFECT).map(id => [id, {}]));
const record = (email, payload, attemptId) => `
  select auth.sign_in_as('${email}');
  select public.talant_record_test_attempt('${VERSION}', '${attemptId}'::uuid, '${JSON.stringify(payload)}'::jsonb);`;

check('perfect answers score full points on the first attempt', () => {
  sql(record('ana@talant.app', PERFECT, 'aaaaaaaa-0000-4000-8000-000000000001'));
  const best = value(`select best_points from public.talant_test_scores
    where user_id = '11111111-1111-4111-8111-111111111111' and quiz_version = '${VERSION}';`);
  assert.strictEqual(Number(best), MAX_POINTS, `expected ${MAX_POINTS}, got ${best}`);
});

check('a later, better attempt raises the score to the new best', () => {
  sql(record('bogdan@talant.app', EMPTY, 'bbbbbbbb-0000-4000-8000-000000000001'));
  const first = Number(value(`select best_points from public.talant_test_scores
    where user_id = '22222222-2222-4222-8222-222222222222' and quiz_version = '${VERSION}';`));
  assert.strictEqual(first, 0, 'empty answers should score zero');
  sql(record('bogdan@talant.app', PERFECT, 'bbbbbbbb-0000-4000-8000-000000000002'));
  const after = Number(value(`select best_points from public.talant_test_scores
    where user_id = '22222222-2222-4222-8222-222222222222' and quiz_version = '${VERSION}';`));
  assert.strictEqual(after, MAX_POINTS, `retry did not raise the score (got ${after}); best-of-all-attempts is not working`);
  const attempts = Number(value(`select attempts from public.talant_test_scores
    where user_id = '22222222-2222-4222-8222-222222222222' and quiz_version = '${VERSION}';`));
  assert.strictEqual(attempts, 2, 'both attempts should still be journalled for audit');
});

check('a later, worse attempt does not lower the score', () => {
  sql(record('bogdan@talant.app', EMPTY, 'bbbbbbbb-0000-4000-8000-000000000003'));
  const after = Number(value(`select best_points from public.talant_test_scores
    where user_id = '22222222-2222-4222-8222-222222222222' and quiz_version = '${VERSION}';`));
  assert.strictEqual(after, MAX_POINTS, `a worse retry lowered the score to ${after}; the best-of-all should hold`);
});

check('display name is frozen against later user_metadata edits', () => {
  // Exact ce poate face un utilizator din browser cu cheia anon:
  // supabase.auth.updateUser({ data: { username: 'Ana' } }).
  sql(`update auth.users set raw_user_meta_data = '{"username":"Impostor"}'
       where id = '11111111-1111-4111-8111-111111111111';`);
  sql(`select auth.sign_in_as('ana@talant.app');
       select public.talant_test_recalculate_own_score('${VERSION}');`);
  const name = value(`select user_name from public.talant_test_scores
    where user_id = '11111111-1111-4111-8111-111111111111' and quiz_version = '${VERSION}';`);
  assert.strictEqual(name, 'Ana', `display name changed to ${name}`);
});

check('a second account cannot take an existing display name', () => {
  // Cont dedicat, pe @talant.app, ca fallback-ul de domeniu @test.com din
  // 20260904d să nu-l scoată din grupa 'general' a lui Ana și să mascheze
  // testul (nou@test.com are propriul test, mai jos, tocmai pentru fallback).
  sql(`insert into auth.users (id, email, raw_user_meta_data) values
      ('99999999-9999-4999-8999-999999999999', 'impostor@talant.app', '{"username":"Ana"}')
    on conflict (id) do nothing;`);
  sql(record('impostor@talant.app', EMPTY, 'dddddddd-0000-4000-8000-000000000001'));
  const name = value(`select user_name from public.talant_test_scores
    where user_id = '99999999-9999-4999-8999-999999999999' and quiz_version = '${VERSION}';`);
  assert.notStrictEqual(name, 'Ana', 'impersonation was allowed');
  assert.ok(/^Ana \d+$/.test(name), `expected a disambiguated name, got ${name}`);
});

check('two accounts in different groups can share a display name', () => {
  sql(`insert into auth.users (id, email, raw_user_meta_data) values
      ('66666666-6666-4666-8666-666666666666', 'dup1@talant.app', '{"username":"Dup"}'),
      ('77777777-7777-4777-8777-777777777777', 'dup2@talant.app', '{"username":"Dup"}')
    on conflict (id) do nothing;
    insert into public.talant_group_members (user_id, group_name)
      values ('77777777-7777-4777-8777-777777777777', 'ci')
      on conflict (user_id) do update set group_name = excluded.group_name;`);
  sql(record('dup1@talant.app', EMPTY, 'ffffffff-0000-4000-8000-000000000001'));
  sql(record('dup2@talant.app', EMPTY, 'ffffffff-0000-4000-8000-000000000002'));
  const name1 = value(`select user_name from public.talant_test_scores
    where user_id = '66666666-6666-4666-8666-666666666666' and quiz_version = '${VERSION}';`);
  const name2 = value(`select user_name from public.talant_test_scores
    where user_id = '77777777-7777-4777-8777-777777777777' and quiz_version = '${VERSION}';`);
  assert.strictEqual(name1, 'Dup', `expected no suffix for the first account, got ${name1}`);
  assert.strictEqual(name2, 'Dup', `a different group still got disambiguated to ${name2}; per-group uniqueness is not working`);
});

check('an account with no username metadata gets a name from its email, not "Utilizator"', () => {
  sql(`insert into auth.users (id, email, raw_user_meta_data) values
      ('88888888-8888-4888-8888-888888888888', 'nometadata@talant.app', '{}')
    on conflict (id) do nothing;`);
  sql(record('nometadata@talant.app', EMPTY, '88888888-0000-4000-8000-000000000001'));
  const name = value(`select user_name from public.talant_test_scores
    where user_id = '88888888-8888-4888-8888-888888888888' and quiz_version = '${VERSION}';`);
  assert.strictEqual(name, 'Nometadata', `expected the email's local part, got ${name}`);
});

check('a self-chosen @test.com address no longer joins the church group', () => {
  // Din 20260904d/e, un email @test.com fără intrare explicită în
  // talant_group_members cade pe 'qa' — nu mai există nicio cale, prin
  // domeniu, către o grupă privilegiată precum 'biserica'. Oricum e
  // discutabil: signUp() din auth.js nu lasă niciodată un elev să aleagă un
  // email/domeniu — accountul ăsta e inserat direct în test, ca să simuleze
  // un apel direct la API-ul Supabase, ocolind formularul.
  const group = value(`select auth.sign_in_as('nou@test.com'); select public.talant_my_group();`).split('\n').pop();
  assert.strictEqual(group, 'qa', `self-registered @test.com landed in ${group}, expected the 'qa' quarantine group`);
  assert.notStrictEqual(group, 'biserica', 'self-registered church domain landed in the privileged church group');
  // 'ci' e rezervat strict botului de CI/E2E (ci@talant.app) — e2e-live.js
  // verifică pe producție că e singurul rând din clasamentul acelei grupe.
  // Un cont @test.com oarecare NU trebuie să ajungă vreodată acolo.
  assert.notStrictEqual(group, 'ci', "a @test.com account landed in the CI bot's reserved group");
});

check('the @test.com fallback only applies without an explicit group membership', () => {
  // vechi@test.com are deja o intrare explicită în talant_group_members
  // ('biserica', populată din vechea regulă la migrarea de întărire) — asta
  // trebuie să câștige mereu în fața fallback-ului pe domeniu.
  const group = value(`select auth.sign_in_as('vechi@test.com'); select public.talant_my_group();`).split('\n').pop();
  assert.strictEqual(group, 'biserica', `explicit membership was overridden by the domain fallback: ${group}`);
});

check('accounts already in the church group keep it', () => {
  sql(record('vechi@test.com', PERFECT, 'cccccccc-0000-4000-8000-000000000001'));
  const group = value(`select auth.sign_in_as('vechi@test.com'); select public.talant_my_group();`).split('\n').pop();
  assert.strictEqual(group, 'biserica', `pre-existing church account fell out into ${group}`);
});

check('editing talant_church_domains no longer moves anyone', () => {
  sql(`insert into public.talant_church_domains (domain) values ('talant.app') on conflict do nothing;`);
  const group = value(`select auth.sign_in_as('ana@talant.app'); select public.talant_my_group();`).split('\n').pop();
  assert.strictEqual(group, 'general', 'the retired domain table still controls grouping');
  sql(`delete from public.talant_church_domains where domain = 'talant.app';`);
});

check('leaderboards stay inside the caller group', () => {
  const general = value(`select auth.sign_in_as('ana@talant.app');
    select count(*) from public.talant_test_leaderboard('${VERSION}', 100);`).split('\n').pop();
  const church = value(`select auth.sign_in_as('vechi@test.com');
    select count(*) from public.talant_test_leaderboard('${VERSION}', 100);`).split('\n').pop();
  assert.strictEqual(Number(church), 1, 'the church leaderboard should only hold its own group');
  assert.ok(Number(general) >= 1, 'the general leaderboard lost its entries');
  const names = value(`select auth.sign_in_as('vechi@test.com');
    select string_agg(user_name, ',') from public.talant_test_leaderboard('${VERSION}', 100);`).split('\n').pop();
  assert.ok(!names.includes('Ana'), 'a general-group account leaked into the church leaderboard');
});

check('a moved account follows its new group on the next save', () => {
  sql(`insert into public.talant_group_members (user_id, group_name)
       values ('55555555-5555-4555-8555-555555555555', 'ci')
       on conflict (user_id) do update set group_name = excluded.group_name;`);
  sql(record('ci@talant.app', PERFECT, 'eeeeeeee-0000-4000-8000-000000000001'));
  const group = value(`select group_name from public.talant_test_scores
    where user_id = '55555555-5555-4555-8555-555555555555' and quiz_version = '${VERSION}';`);
  assert.strictEqual(group, 'ci');
  const seenByStudent = value(`select auth.sign_in_as('ana@talant.app');
    select coalesce(string_agg(user_name, ','), '') from public.talant_test_leaderboard('${VERSION}', 100);`).split('\n').pop();
  assert.ok(!seenByStudent.includes('Ci'), 'the CI account is visible in a student leaderboard');
});

check('unauthenticated calls are still refused', () => {
  sql(`select auth.sign_out();
       select public.talant_record_test_attempt('${VERSION}', gen_random_uuid(), '{}'::jsonb);`,
    { expectFailure: true });
});

check('an unknown quiz version is refused', () => {
  sql(`select auth.sign_in_as('ana@talant.app');
       select public.talant_record_test_attempt('nu-exista-v2', gen_random_uuid(), '{}'::jsonb);`,
    { expectFailure: true });
});

check('my_stats reports the cap so the page can warn', () => {
  const row = value(`select auth.sign_in_as('ana@talant.app');
    select scored_attempts from public.talant_test_my_stats('${VERSION}');`).split('\n').pop();
  assert.strictEqual(Number(row), 1);
});

let started = false;
try {
  if (!DB_URL) {
    if (!haveDocker()) {
      console.log('Skipping database checks: no TALANT_TEST_DB_URL and Docker is not available.');
      process.exit(0);
    }
    startContainer();
    started = true;
  }
  applyMigrations();
  console.log(`Applied ${MIGRATIONS.length} migrations to a throwaway database.`);

  let failures = 0;
  for (const [name, fn] of CHECKS) {
    try {
      fn();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failures++;
      console.error(`  FAIL ${name}\n       ${error.message.split('\n').join('\n       ')}`);
    }
  }
  if (failures) {
    console.error(`\n${failures} of ${CHECKS.length} database checks failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${CHECKS.length} database checks passed.`);
  }
} finally {
  if (started && !process.env.TALANT_KEEP_TEST_DB) docker(['rm', '-f', CONTAINER]);
}
