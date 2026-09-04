-- Corectează o abatere găsită prin audit: toate funcțiile talant_* aveau
-- EXECUTE acordat și lui `anon` (probabil un GRANT ... TO PUBLIC/anon rulat
-- din greșeală), deși nicio migrare din supabase/ nu a acordat vreodată asta —
-- designul cere authenticated-only peste tot. Revocă anon, păstrează
-- authenticated. Sigur de rulat de oricâte ori (idempotent).

revoke execute on function public.talant_display_name() from anon;
revoke execute on function public.talant_leaderboard(integer) from anon;
revoke execute on function public.talant_my_attempts(integer) from anon;
revoke execute on function public.talant_my_group() from anon;
revoke execute on function public.talant_my_stats() from anon;
revoke execute on function public.talant_recalculate_own_score() from anon;
revoke execute on function public.talant_record_attempt(text, integer, jsonb, uuid) from anon;
revoke execute on function public.talant_record_test_attempt(text, uuid, jsonb) from anon;
revoke execute on function public.talant_scored_attempts(text) from anon;
revoke execute on function public.talant_test_leaderboard(text, integer) from anon;
revoke execute on function public.talant_test_my_attempts(text, integer) from anon;
revoke execute on function public.talant_test_my_stats(text) from anon;
revoke execute on function public.talant_test_recalculate_own_score(text) from anon;
revoke execute on function public.talant_user_group() from anon;

-- Verificare: acest select trebuie să întoarcă ZERO rânduri după ce rulezi de mai sus.
select p.proname, r.rolname as grantee
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'public'
  and p.proname like 'talant_%'
  and r.rolname = 'anon'
  and has_function_privilege(r.oid, p.oid, 'EXECUTE');
