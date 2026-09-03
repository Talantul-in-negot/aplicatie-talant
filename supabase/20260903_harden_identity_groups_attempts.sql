-- Talant: identitate stabilă, grupe atribuite pe server și încercări punctate limitat.
--
-- Repară trei căi prin care clasamentul putea fi manipulat din browser:
--   1. Numele afișat venea din user_metadata.username, pe care orice cont și-l
--      poate rescrie singur cu cheia anon (auth.updateUser) — deci un elev putea
--      apărea în clasament sub numele altuia. Numele se fixează acum o singură
--      dată, în talant_profiles, și este unic.
--   2. Grupa ("biserica" / "general") era dedusă din domeniul emailului, pe care
--      utilizatorul îl alege singur la înregistrare — deci oricine putea intra în
--      clasamentul bisericii scriind un email @test.com. Grupa se citește acum
--      dintr-un tabel administrat exclusiv pe server.
--   3. Numărul de încercări punctate era nelimitat și se păstra maximul, deci
--      scorul putea fi urcat prin reluări repetate. Se punctează doar primele N
--      încercări (implicit 1); restul rămân în jurnal, dar nu schimbă scorul.
--
-- Migrarea este strict aditivă și idempotentă: nu șterge nicio încercare și
-- niciun scor existent.
begin;

-- ── 1. Nume afișat stabil și unic ──────────────────────────────────────────
create table if not exists public.talant_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  user_name text not null,
  created_at timestamptz not null default now()
);
alter table public.talant_profiles enable row level security;
revoke all on public.talant_profiles from anon, authenticated;
create unique index if not exists talant_profiles_name_key on public.talant_profiles (lower(user_name));

-- Preia numele deja folosite în clasamente, ca utilizatorii existenți să nu fie
-- redenumiți. Dacă două conturi vechi împart același nume, cel înregistrat mai
-- devreme îl păstrează; celălalt primește un sufix la următoarea salvare de scor.
insert into public.talant_profiles (user_id, user_name)
select distinct on (lower(user_name)) user_id, user_name
from (
  select user_id, user_name, updated_at from public.talant_test_scores
  union all
  select user_id, user_name, updated_at from public.talant_scores
) existing
where nullif(trim(user_name), '') is not null
order by lower(user_name), updated_at asc
on conflict do nothing;

-- Numele afișat al contului curent. La prima folosire îl fixează din JWT; după
-- aceea valoarea stocată este singura sursă, deci o schimbare ulterioară a
-- user_metadata nu mai poate schimba numele din clasament.
create or replace function public.talant_display_name()
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_existing text;
  v_wanted text;
  v_candidate text;
  v_suffix integer := 1;
begin
  if v_user_id is null then raise exception 'Authentication is required'; end if;
  select user_name into v_existing from public.talant_profiles where user_id = v_user_id;
  if v_existing is not null then return v_existing; end if;

  v_wanted := left(initcap(split_part(coalesce(nullif(trim(auth.jwt() -> 'user_metadata' ->> 'username'), ''), 'Utilizator'), '@', 1)), 30);
  if nullif(trim(v_wanted), '') is null then v_wanted := 'Utilizator'; end if;
  v_candidate := v_wanted;
  loop
    begin
      insert into public.talant_profiles (user_id, user_name) values (v_user_id, v_candidate);
      return v_candidate;
    exception when unique_violation then
      -- Poate fi propriul rând (inserat concurent) sau numele altui cont.
      select user_name into v_existing from public.talant_profiles where user_id = v_user_id;
      if v_existing is not null then return v_existing; end if;
      v_suffix := v_suffix + 1;
      if v_suffix > 50 then raise exception 'Could not allocate a display name'; end if;
      v_candidate := left(v_wanted, 26) || ' ' || v_suffix;
    end;
  end loop;
end;
$$;

-- ── 2. Grupe atribuite pe server ───────────────────────────────────────────
create table if not exists public.talant_group_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  group_name text not null check (nullif(trim(group_name), '') is not null),
  assigned_at timestamptz not null default now()
);
alter table public.talant_group_members enable row level security;
revoke all on public.talant_group_members from anon, authenticated;
create index if not exists talant_group_members_group_idx on public.talant_group_members (group_name);

comment on table public.talant_group_members is
  'Apartenenta la grupa. Se administreaza exclusiv din SQL Editor / service role - niciun RPC nu scrie aici, ca utilizatorul sa nu-si poata alege grupa.';
comment on table public.talant_church_domains is
  'ISTORIC: folosit o singura data pentru popularea talant_group_members in migrarea de intarire. Nu mai este consultat la runtime - modificarea lui nu mai schimba nicio grupa.';

-- Populare unică din regula veche, ca membrii actuali ai bisericii să rămână în
-- grupa lor. Din acest punct, apartenența se schimbă doar manual.
insert into public.talant_group_members (user_id, group_name)
select u.id, 'biserica'
from auth.users u
where exists (
  select 1 from public.talant_church_domains d
  where lower(u.email) like ('%@' || lower(d.domain))
)
on conflict (user_id) do nothing;

create or replace function public.talant_user_group()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select m.group_name from public.talant_group_members m where m.user_id = auth.uid()),
    'general');
$$;

-- Permite testului live să confirme că rulează într-o grupă izolată, ca scorul
-- contului de CI să nu apară în clasamentul elevilor.
create or replace function public.talant_my_group()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select public.talant_user_group();
$$;

-- ── 3. Doar primele N încercări sunt punctate ──────────────────────────────
create table if not exists public.talant_quiz_settings (
  quiz_version text primary key,
  scored_attempts integer not null default 1 check (scored_attempts > 0)
);
alter table public.talant_quiz_settings enable row level security;
revoke all on public.talant_quiz_settings from anon, authenticated;
comment on table public.talant_quiz_settings is
  'Cate incercari intra in clasament, pe versiune de test. Randul "*" este valoarea implicita.';

insert into public.talant_quiz_settings (quiz_version, scored_attempts) values ('*', 1)
  on conflict (quiz_version) do nothing;

create or replace function public.talant_scored_attempts(p_quiz_version text)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select s.scored_attempts from public.talant_quiz_settings s where s.quiz_version = p_quiz_version),
    (select s.scored_attempts from public.talant_quiz_settings s where s.quiz_version = '*'),
    1);
$$;

-- ── 4. Funcțiile de scorare folosesc identitatea stabilă și plafonul ───────
create or replace function public.talant_recalculate_own_score()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_correct integer;
  v_attempts integer;
begin
  if v_user_id is null then raise exception 'Authentication is required'; end if;
  v_name := public.talant_display_name();
  select count(*) filter (where correct), count(*) into v_correct, v_attempts
    from public.talant_attempts
    where user_id = v_user_id and quiz_version = 'ioan-v2';
  insert into public.talant_scores (user_id, user_name, points, correct_answers, attempts, accuracy, score_version, updated_at)
  values (v_user_id, v_name, v_correct, v_correct, v_attempts,
          case when v_attempts = 0 then 0 else round(100.0 * v_correct / v_attempts)::integer end, 'ioan-v2', now())
  on conflict (user_id) do update set user_name = excluded.user_name, points = excluded.points,
    correct_answers = excluded.correct_answers, attempts = excluded.attempts, accuracy = excluded.accuracy,
    score_version = excluded.score_version, updated_at = excluded.updated_at;
end;
$$;

create or replace function public.talant_record_attempt(
  p_quiz_version text,
  p_question_id integer,
  p_selected_indices jsonb,
  p_client_attempt_id uuid
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_correct boolean;
begin
  if v_user_id is null then raise exception 'Authentication is required'; end if;
  if jsonb_typeof(p_selected_indices) <> 'array' then raise exception 'Invalid answer'; end if;
  select k.correct_indices = p_selected_indices into v_correct
    from public.talant_quiz_answer_keys k
    where k.quiz_version = p_quiz_version and k.question_id = p_question_id;
  if v_correct is null then raise exception 'Unknown quiz question'; end if;
  v_name := public.talant_display_name();
  insert into public.talant_attempts
    (user_id, user_name, client_attempt_id, question_id, round_key, quiz_version, selected_indices, correct, attempted_at)
  values (v_user_id, v_name, p_client_attempt_id, p_question_id, '', p_quiz_version, p_selected_indices, v_correct, now())
  on conflict (user_id, quiz_version, question_id) where quiz_version = 'ioan-v2' do update set
    client_attempt_id = excluded.client_attempt_id, user_name = excluded.user_name,
    selected_indices = case when excluded.correct then excluded.selected_indices else public.talant_attempts.selected_indices end,
    correct = public.talant_attempts.correct or excluded.correct, attempted_at = excluded.attempted_at,
    recorded_at = now();
  perform public.talant_recalculate_own_score();
end;
$$;

-- Punctează doar primele talant_scored_attempts() încercări, în ordinea în care
-- au fost înregistrate pe server. Reluările ulterioare rămân în jurnal pentru
-- audit, dar nu mai pot urca scorul din clasament.
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
  select count(*) into v_attempts
    from public.talant_test_attempts
    where user_id = v_user_id and quiz_version = p_quiz_version;
  select max(scored.total_points), max(scored.max_points) into v_best, v_max
    from (
      select a.total_points, a.max_points
      from public.talant_test_attempts a
      where a.user_id = v_user_id and a.quiz_version = p_quiz_version
      order by a.recorded_at asc, a.id asc
      limit public.talant_scored_attempts(p_quiz_version)
    ) scored;
  insert into public.talant_test_scores (user_id, quiz_version, user_name, group_name, best_points, max_points, attempts, updated_at)
  values (v_user_id, p_quiz_version, v_name, v_group, coalesce(v_best, 0), coalesce(v_max, 0), coalesce(v_attempts, 0), now())
  on conflict (user_id, quiz_version) do update set user_name = excluded.user_name, group_name = excluded.group_name,
    best_points = excluded.best_points, max_points = excluded.max_points, attempts = excluded.attempts, updated_at = excluded.updated_at;
end;
$$;

create or replace function public.talant_record_test_attempt(
  p_quiz_version text,
  p_client_attempt_id uuid,
  p_answers jsonb
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_total integer;
  v_max integer;
  v_sections jsonb;
begin
  if v_user_id is null then raise exception 'Authentication is required'; end if;
  if jsonb_typeof(p_answers) <> 'object' then raise exception 'Invalid answers'; end if;
  if not exists (select 1 from public.talant_test_answer_keys where quiz_version = p_quiz_version) then
    raise exception 'Unknown quiz version';
  end if;
  select coalesce(sum(case when coalesce(p_answers #> array[k.section_id, k.item_index::text], 'null'::jsonb) = k.correct_answer then k.points else 0 end), 0),
         coalesce(sum(k.points), 0)
    into v_total, v_max from public.talant_test_answer_keys k where k.quiz_version = p_quiz_version;
  select coalesce(jsonb_object_agg(section_id, jsonb_build_object('earned', earned, 'max', max_points)), '{}'::jsonb)
    into v_sections from (
      select k.section_id,
        sum(case when coalesce(p_answers #> array[k.section_id, k.item_index::text], 'null'::jsonb) = k.correct_answer then k.points else 0 end)::integer as earned,
        sum(k.points)::integer as max_points
      from public.talant_test_answer_keys k where k.quiz_version = p_quiz_version group by k.section_id
    ) section_totals;
  v_name := public.talant_display_name();
  insert into public.talant_test_attempts
    (user_id, user_name, client_attempt_id, quiz_version, total_points, max_points, section_scores, attempted_at)
  values (v_user_id, v_name, p_client_attempt_id, p_quiz_version, v_total, v_max, v_sections, now())
  on conflict (client_attempt_id) do nothing;
  perform public.talant_test_recalculate_own_score(p_quiz_version);
end;
$$;

-- Statisticile proprii expun și plafonul, ca pagina să poată avertiza înainte de
-- încercarea care intră în clasament.
drop function if exists public.talant_test_my_stats(text);
create or replace function public.talant_test_my_stats(p_quiz_version text)
returns table(best_points integer, max_points integer, attempts integer, scored_attempts integer, updated_at timestamptz)
language sql security definer set search_path = public, pg_temp as $$
  select s.best_points, s.max_points, s.attempts,
         public.talant_scored_attempts(p_quiz_version), s.updated_at
  from public.talant_test_scores s
  where s.user_id = auth.uid() and s.quiz_version = p_quiz_version;
$$;

-- ── 5. Alinierea datelor existente ─────────────────────────────────────────
update public.talant_test_scores s set user_name = p.user_name
  from public.talant_profiles p
  where p.user_id = s.user_id and s.user_name is distinct from p.user_name;
update public.talant_scores s set user_name = p.user_name
  from public.talant_profiles p
  where p.user_id = s.user_id and s.user_name is distinct from p.user_name;
update public.talant_test_scores s
  set group_name = coalesce((select m.group_name from public.talant_group_members m where m.user_id = s.user_id), 'general')
  where s.group_name is distinct from coalesce((select m.group_name from public.talant_group_members m where m.user_id = s.user_id), 'general');

-- Reaplică plafonul asupra scorurilor deja salvate, ca un scor obținut prin
-- reluări repetate înainte de această migrare să nu rămână în clasament.
update public.talant_test_scores s
set best_points = coalesce(capped.best_points, 0),
    max_points = coalesce(capped.max_points, s.max_points)
from (
  select t.user_id, t.quiz_version,
    (select max(x.total_points) from (
       select a.total_points from public.talant_test_attempts a
       where a.user_id = t.user_id and a.quiz_version = t.quiz_version
       order by a.recorded_at asc, a.id asc
       limit public.talant_scored_attempts(t.quiz_version)) x) as best_points,
    (select max(x.max_points) from (
       select a.max_points from public.talant_test_attempts a
       where a.user_id = t.user_id and a.quiz_version = t.quiz_version
       order by a.recorded_at asc, a.id asc
       limit public.talant_scored_attempts(t.quiz_version)) x) as max_points
  from (select distinct user_id, quiz_version from public.talant_test_attempts) t
) capped
where capped.user_id = s.user_id and capped.quiz_version = s.quiz_version;

-- ── 6. Drepturi ────────────────────────────────────────────────────────────
revoke all on function public.talant_display_name() from public;
revoke all on function public.talant_scored_attempts(text) from public;
revoke all on function public.talant_user_group() from public;
revoke all on function public.talant_my_group() from public;
revoke all on function public.talant_test_my_stats(text) from public;
grant execute on function public.talant_user_group() to authenticated;
grant execute on function public.talant_my_group() to authenticated;
grant execute on function public.talant_test_my_stats(text) to authenticated;

commit;
