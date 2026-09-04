-- Talant: schimbă politica de scorare a testelor "Talantul în negoț" din
-- "doar primele N încercări" la "cel mai bun scor din toate încercările".
--
-- Decizie de produs (nu o remediere de securitate): plafonul introdus în
-- 20260903_harden_identity_groups_attempts.sql împiedica un elev să-și
-- îmbunătățească scorul din clasament la reîncercare, chiar dacă motivul lui
-- era corectarea unei greșeli, nu manipularea scorului. Se renunță la ordinea
-- încercărilor; contează cea mai bună dintre toate. Jurnalul de încercări
-- (talant_test_attempts) și tabelul talant_quiz_settings rămân neatinse —
-- doar recalcularea scorului se schimbă.
--
-- Migrarea este strict aditivă și idempotentă.
begin;

create or replace function public.talant_test_recalculate_own_score(p_quiz_version text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_group text;
  v_best integer;
  v_max integer;
  v_attempts integer;
begin
  if v_user_id is null then raise exception 'Authentication is required'; end if;
  v_name := public.talant_display_name();
  v_group := public.talant_user_group();
  -- Cel mai bun scor din toate încercările (nu doar din primele N) — un elev
  -- care corectează o greșeală la o reluare ulterioară vede clasamentul
  -- actualizat, nu blocat la prima încercare.
  select count(*), max(a.total_points), max(a.max_points)
    into v_attempts, v_best, v_max
    from public.talant_test_attempts a
    where a.user_id = v_user_id and a.quiz_version = p_quiz_version;
  insert into public.talant_test_scores (user_id, quiz_version, user_name, group_name, best_points, max_points, attempts, updated_at)
  values (v_user_id, p_quiz_version, v_name, v_group, coalesce(v_best, 0), coalesce(v_max, 0), coalesce(v_attempts, 0), now())
  on conflict (user_id, quiz_version) do update set user_name = excluded.user_name, group_name = excluded.group_name,
    best_points = excluded.best_points, max_points = excluded.max_points, attempts = excluded.attempts, updated_at = excluded.updated_at;
end;
$$;

-- Recalculează imediat scorurile deja salvate, ca elevii ale căror reîncercări
-- ulterioare erau mai bune să nu aștepte până la următoarea trimitere. Se
-- calculează direct pe tabele (nu prin funcția de mai sus, care are nevoie de
-- auth.uid() dintr-o cerere autentificată — aici rulăm ca rol de service).
update public.talant_test_scores s
set best_points = agg.best_points, max_points = agg.max_points, attempts = agg.attempts
from (
  select a.user_id, a.quiz_version,
    max(a.total_points) as best_points, max(a.max_points) as max_points, count(*) as attempts
  from public.talant_test_attempts a
  group by a.user_id, a.quiz_version
) agg
where agg.user_id = s.user_id and agg.quiz_version = s.quiz_version
  and (s.best_points, s.max_points, s.attempts) is distinct from (agg.best_points, agg.max_points, agg.attempts);

revoke all on function public.talant_test_recalculate_own_score(text) from public;

commit;
