-- Audit doar-citire, de rulat manual în Supabase SQL Editor după orice
-- query rulat din greșeală, ca să confirmăm că nimic important nu s-a schimbat.
-- Nu modifică nimic — sigur de rulat oricând.

-- 1. Migrațiile aplicate — ar trebui să coincidă cu supabase/migrations.txt
select name, applied_at from public.talant_migration_history order by applied_at;

-- 2. Plafonul de încercări punctate — implicit trebuie să fie 1 pentru '*'
select * from public.talant_quiz_settings order by quiz_version;

-- 3. Numărul de rânduri din tabelele critice (comparabil cu ce știi că ar trebui să fie)
select 'talant_profiles' as tbl, count(*) from public.talant_profiles
union all select 'talant_group_members', count(*) from public.talant_group_members
union all select 'talant_scores', count(*) from public.talant_scores
union all select 'talant_test_scores', count(*) from public.talant_test_scores
union all select 'talant_attempts', count(*) from public.talant_attempts
union all select 'talant_test_attempts', count(*) from public.talant_test_attempts
union all select 'talant_quiz_answer_keys', count(*) from public.talant_quiz_answer_keys
union all select 'talant_test_answer_keys', count(*) from public.talant_test_answer_keys
union all select 'talant_church_domains', count(*) from public.talant_church_domains;

-- 4. Permisiuni pe tabelele sensibile — anon/authenticated NU trebuie să aibă
--    niciun drept direct (totul trece prin funcții security definer)
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'talant_profiles','talant_group_members','talant_quiz_settings',
    'talant_scores','talant_test_scores','talant_attempts','talant_test_attempts',
    'talant_quiz_answer_keys','talant_test_answer_keys'
  )
  and grantee in ('anon','authenticated')
order by table_name, grantee;

-- 5. Cine poate executa funcțiile RPC publice — doar 'authenticated', nu 'anon'/'public'
select p.proname, r.rolname as grantee, has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'public'
  and p.proname like 'talant_%'
  and r.rolname in ('anon','authenticated','public')
  and has_function_privilege(r.oid, p.oid, 'EXECUTE')
order by p.proname, r.rolname;

-- 6. Bareme suspecte: chei de răspuns goale sau puncte <= 0 (ar trebui gol rezultatul)
select * from public.talant_quiz_answer_keys where correct_indices is null;
select * from public.talant_test_answer_keys where points <= 0 or correct_answer is null;

-- 7. Scoruri negative sau incoerente (best_points > max_points) — ar trebui gol
select * from public.talant_test_scores where best_points > max_points or best_points < 0;
select * from public.talant_scores where correct_answers > attempts or points < 0;
