'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const databaseUrl = process.env.SUPABASE_DB_URL;
if (!databaseUrl) throw new Error('SUPABASE_DB_URL is required. Store it as a protected GitHub Actions secret.');

const root = __dirname;
const manifest = fs.readFileSync(path.join(root, 'supabase', 'migrations.txt'), 'utf8')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'));

// Runs a migration/DDL script with its output streamed straight to the CI log
// (stdout not captured — every CREATE/GRANT/INSERT stays visible for audit).
function psql(args, input) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', ...args], {
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    input,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

// Runs a read query and returns its output as a string. Stdout must be
// captured here (not inherited like psql() above), or the caller can never
// see the result — the "already applied?" check silently always saw an empty
// string and re-ran every migration on every invocation, crashing on the
// second run with a duplicate-key error. Still prints stderr on failure, so a
// bad query is never silent.
function psqlQuery(args, input) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', ...args], {
    input,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return String(result.stdout || '').trim();
}

psql(['-f', '-'], `
  create table if not exists public.talant_migration_history (
    name text primary key,
    applied_at timestamptz not null default now()
  );
  revoke all on public.talant_migration_history from anon, authenticated;
`);

for (const file of manifest) {
  if (!/^[a-zA-Z0-9_.-]+\.sql$/.test(file)) throw new Error(`Invalid migration filename: ${file}`);
  const fullPath = path.join(root, 'supabase', file);
  if (!fs.existsSync(fullPath)) throw new Error(`Missing migration: ${file}`);
  // psql's -c/-tAc single-command mode never interpolates :'var' — that only
  // happens in script mode (-f), hence -tA + -f - here instead of -tAc.
  const check = psqlQuery(['-tA', '-v', `name=${file}`, '-f', '-'],
    `select 1 from public.talant_migration_history where name = :'name';\n`);
  if (check === '1') { console.log(`Skipping ${file} (already applied).`); continue; }

  console.log(`Applying ${file}...`);
  // psql already wraps the whole input in one transaction (-1). A literal
  // begin;/commit; inside the file would close that transaction early, so the
  // history insert could commit separately from the migration it records.
  // Every migration opens with a comment block, so anchoring to the start of
  // the file never matched — strip the standalone statements wherever they are.
  const sql = fs.readFileSync(fullPath, 'utf8')
    .replace(/^[ \t]*(?:begin|commit)[ \t]*;[ \t]*\r?$/gim, '');
  psql(['-1', '-v', `name=${file}`, '-f', '-'],
    `${sql}\ninsert into public.talant_migration_history(name) values (:'name');\n`);
}

console.log(`Applied ${manifest.length} migrations.`);
