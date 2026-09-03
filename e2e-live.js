'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const baseUrl = (process.env.TALANT_BASE_URL || 'https://talantul-in-negot.github.io/aplicatie-talant/').replace(/\/?$/, '/');
const email = process.env.TALANT_E2E_EMAIL;
const password = process.env.TALANT_E2E_PASSWORD;
if (!email || !password) throw new Error('TALANT_E2E_EMAIL and TALANT_E2E_PASSWORD are required for the live test account.');

const config = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
const supabaseUrl = /SUPABASE_URL\s*=\s*["']([^"']+)/.exec(config)?.[1];
const anonKey = /SUPABASE_ANON_KEY\s*=\s*["']([^"']+)/.exec(config)?.[1];
if (!supabaseUrl || !anonKey) throw new Error('Could not read Supabase public configuration.');

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${response.status} ${typeof body === 'string' ? body : body?.message || body?.error_description || 'request failed'}`);
  return body;
}

async function rpc(token, name, body) {
  return jsonRequest(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

(async () => {
  const page = await fetch(`${baseUrl}?e2e=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  const html = await page.text();
  if (!page.ok || !html.includes('samuel1-3-v2') || !html.includes('p_answers: submittedAnswers')) {
    throw new Error('The public site is not serving the secure Samuel v2 page.');
  }
  if (!/integrity="sha384-/.test(html)) {
    throw new Error('The published page loads supabase-js without a subresource integrity hash.');
  }

  // Site-ul este publicat din rădăcina repo-ului, deci o excludere greșită în
  // _config.yml ar reda baremele complete publice. Verificăm pe site-ul real.
  for (const leaked of ['supabase/20260824_secure_scoring.sql', 'supabase/migrations.txt', 'verify-project.js']) {
    const probe = await fetch(`${baseUrl}${leaked}?e2e=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
    if (probe.ok) {
      throw new Error(`The published site is serving ${leaked} (HTTP ${probe.status}). Answer keys must not be public.`);
    }
  }

  const auth = await jsonRequest(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const token = auth.access_token;
  if (!token || !auth.user?.id) throw new Error('The live test account did not authenticate.');

  const data = require(path.join(__dirname, 'data', '1samuel-1-3.js'));
  const answers = {};
  let expectedPoints = 0;
  for (const section of data.sections) {
    const items = section.type === 'match' ? section.left : section.items;
    answers[section.id] = {};
    items.forEach((item, index) => {
      answers[section.id][index] = section.type === 'multi' ? [...item.correct].sort() : item.correct;
      expectedPoints += section.points;
    });
  }

  const hash = crypto.createHash('sha256').update(auth.user.id + ':samuel1-3-v2').digest('hex');
  const stableId = process.env.TALANT_E2E_ATTEMPT_ID || `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  await rpc(token, 'talant_record_test_attempt', {
    p_quiz_version: 'samuel1-3-v2',
    p_client_attempt_id: stableId,
    p_answers: answers,
  });

  // Contul de CI trebuie să stea într-o grupă proprie, altfel scorul lui apare
  // în clasamentul elevilor la fiecare push. Grupa se atribuie o singură dată:
  //   insert into public.talant_group_members (user_id, group_name)
  //   values ('<id-ul contului>', 'ci');
  const group = await rpc(token, 'talant_my_group', {});
  if (String(group) !== 'ci') {
    throw new Error(`The CI account is in group "${group}", so its score appears in a student leaderboard. `
      + `Run: insert into public.talant_group_members (user_id, group_name) values ('${auth.user.id}', 'ci');`);
  }

  const statsRows = await rpc(token, 'talant_test_my_stats', { p_quiz_version: 'samuel1-3-v2' });
  const stats = Array.isArray(statsRows) ? statsRows[0] : statsRows;
  if (!stats || Number(stats.best_points) !== expectedPoints || Number(stats.max_points) !== expectedPoints) {
    const cap = Number(stats?.scored_attempts) || 1;
    const used = Number(stats?.attempts) || 0;
    const hint = used > cap
      ? ` The account already has ${used} attempts and only the first ${cap} are scored — recreate the CI account.`
      : '';
    throw new Error(`Score mismatch: expected ${expectedPoints}/${expectedPoints}, received ${stats?.best_points}/${stats?.max_points}.${hint}`);
  }

  // În grupa izolată a CI-ului clasamentul trebuie să conțină exact acest cont,
  // ceea ce confirmă și scorarea, și izolarea pe grupe.
  const leaderboard = await rpc(token, 'talant_test_leaderboard', { p_quiz_version: 'samuel1-3-v2', p_limit: 100 });
  if (!Array.isArray(leaderboard) || leaderboard.length !== 1) {
    throw new Error(`Expected exactly one entry in the isolated CI leaderboard, received ${leaderboard?.length}.`);
  }
  if (Number(leaderboard[0].best_points) !== expectedPoints) {
    throw new Error(`The CI leaderboard entry shows ${leaderboard[0].best_points} instead of ${expectedPoints}.`);
  }

  console.log(`Live E2E passed: answer keys are not published, authentication, `
    + `${expectedPoints}-point server-scored result, and an isolated leaderboard entry.`);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
