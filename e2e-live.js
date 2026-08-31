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

  const statsRows = await rpc(token, 'talant_test_my_stats', { p_quiz_version: 'samuel1-3-v2' });
  const stats = Array.isArray(statsRows) ? statsRows[0] : statsRows;
  if (!stats || Number(stats.best_points) !== expectedPoints || Number(stats.max_points) !== expectedPoints) {
    throw new Error(`Score mismatch: expected ${expectedPoints}/${expectedPoints}, received ${stats?.best_points}/${stats?.max_points}.`);
  }

  const leaderboard = await rpc(token, 'talant_test_leaderboard', { p_quiz_version: 'samuel1-3-v2', p_limit: 100 });
  // Keep this assertion aligned with talant_test_recalculate_own_score: accounts
  // without an explicit username are recorded as "Utilizator", not their email.
  const expectedName = String(auth.user.user_metadata?.username || 'Utilizator').split('@')[0].toLocaleLowerCase('ro-RO');
  const found = Array.isArray(leaderboard) && leaderboard.some(row => String(row.user_name).toLocaleLowerCase('ro-RO') === expectedName && Number(row.best_points) === expectedPoints);
  if (!found) throw new Error('The test account score was saved but was not returned by its leaderboard.');

  console.log(`Live E2E passed: authentication, ${expectedPoints}-point score, and leaderboard entry.`);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
