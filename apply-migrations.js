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

function psql(args, input) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', ...args], {
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    input,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
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
  const check = spawnSync('psql', [databaseUrl, '-X', '-v', `name=${file}`, '-tAc',
    `select 1 from public.talant_migration_history where name = :'name'`], {
    encoding: 'utf8', env: process.env,
  });
  if (check.error) throw check.error;
  if (check.status !== 0) process.exit(check.status || 1);
  if (check.stdout.trim() === '1') { console.log(`Skipping ${file} (already applied).`); continue; }

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
