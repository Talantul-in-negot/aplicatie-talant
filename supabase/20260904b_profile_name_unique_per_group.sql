-- Talant: unicitatea numelui afișat devine per-grupă, nu globală.
--
-- Decizie de produs, discutată explicit: clasamentul (talant_test_leaderboard /
-- talant_leaderboard) e deja izolat pe grupă — doi utilizatori din grupe
-- diferite nu apar niciodată în același clasament (vezi verificarea
-- "leaderboards stay inside the caller group" din scripts/verify-migrations.js).
-- Deci a bloca același nume între grupe diferite era mai strict decât e nevoie.
-- Rămâne blocat, ca înainte, ca doi utilizatori din ACEEAȘI grupă să aibă
-- același nume (asta ar crea impersonare vizibilă în același clasament).
--
-- Migrarea este strict aditivă: nu șterge niciun rând existent. Trecerea de la
-- unicitate globală la unicitate per-grupă nu poate crea conflicte pe datele
-- deja salvate (orice set de nume deja unic global e automat unic și per-grupă).
begin;

-- ── 1. Grupa se fixează în profil, în același moment cu numele ────────────
-- (nu se resincronizează dacă utilizatorul e mutat ulterior de admin — la fel
-- ca numele însuși, e o valoare "înghețată" la prima alocare, nu una vie.)
alter table public.talant_profiles add column if not exists group_name text;
update public.talant_profiles p
  set group_name = coalesce((select m.group_name from public.talant_group_members m where m.user_id = p.user_id), 'general')
  where p.group_name is null;
alter table public.talant_profiles alter column group_name set not null;
alter table public.talant_profiles alter column group_name set default 'general';

drop index if exists public.talant_profiles_name_key;
create unique index if not exists talant_profiles_group_name_key
  on public.talant_profiles (group_name, lower(user_name));

-- ── 2. talant_display_name() scrie și grupa la alocare ─────────────────────
create or replace function public.talant_display_name()
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_group text;
  v_existing text;
  v_wanted text;
  v_candidate text;
  v_suffix integer := 1;
begin
  if v_user_id is null then raise exception 'Authentication is required'; end if;
  select user_name into v_existing from public.talant_profiles where user_id = v_user_id;
  if v_existing is not null then return v_existing; end if;

  v_group := public.talant_user_group();
  v_wanted := left(initcap(split_part(coalesce(nullif(trim(auth.jwt() -> 'user_metadata' ->> 'username'), ''), 'Utilizator'), '@', 1)), 30);
  if nullif(trim(v_wanted), '') is null then v_wanted := 'Utilizator'; end if;
  v_candidate := v_wanted;
  loop
    begin
      insert into public.talant_profiles (user_id, user_name, group_name) values (v_user_id, v_candidate, v_group);
      return v_candidate;
    exception when unique_violation then
      -- Poate fi propriul rând (inserat concurent) sau numele altui cont DIN
      -- ACEEAȘI GRUPĂ (indexul unic e acum pe (group_name, lower(user_name))).
      select user_name into v_existing from public.talant_profiles where user_id = v_user_id;
      if v_existing is not null then return v_existing; end if;
      v_suffix := v_suffix + 1;
      if v_suffix > 50 then raise exception 'Could not allocate a display name'; end if;
      v_candidate := left(v_wanted, 26) || ' ' || v_suffix;
    end;
  end loop;
end;
$$;

revoke all on function public.talant_display_name() from public;

commit;
