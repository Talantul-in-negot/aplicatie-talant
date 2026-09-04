-- Talant: repară o greșeală din migrarea anterioară (20260904d). Grupa `ci`
-- e rezervată strict contului real de CI/E2E (`ci@talant.app`) — e2e-live.js
-- verifică pe producție că e SINGURUL rând din clasamentul acelei grupe, ca
-- rulările automate să nu polueze un clasament vizibil elevilor. Fallback-ul
-- pentru conturi @test.com a fost greșit țintit tot spre `ci`, deci orice
-- cont de test personal ajungea automat în grupa botului de CI, stricând
-- exact garanția aceea. Îl mut pe o grupă nouă, `qa`, dedicată conturilor de
-- test manuale — `ci` rămâne exclusiv a botului.
begin;

create or replace function public.talant_user_group()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select m.group_name from public.talant_group_members m where m.user_id = auth.uid()),
    case when lower(auth.jwt() ->> 'email') like '%@test.com' then 'qa' end,
    'general');
$$;

-- Scoate din grupa botului orice cont care nu e chiar botul de CI.
update public.talant_group_members m
set group_name = 'qa'
from auth.users u
where u.id = m.user_id and m.group_name = 'ci' and u.email <> 'ci@talant.app';

-- Un cont @test.com fără intrare explicită ar fi căzut, până acum, tot pe
-- fallback-ul greșit ('ci') — îi dăm o intrare explicită pe 'qa', ca
-- schimbarea de mai sus să fie completă chiar și pentru conturi care nu
-- aveau încă niciun rând în talant_group_members.
insert into public.talant_group_members (user_id, group_name)
select u.id, 'qa' from auth.users u
where lower(u.email) like '%@test.com'
  and u.email <> 'ci@talant.app'
  and not exists (select 1 from public.talant_group_members m where m.user_id = u.id)
on conflict (user_id) do nothing;

-- Realiniază scorurile/profilurile deja salvate, ca leaderboard-ul botului
-- să redevină corect imediat, nu abia la următoarea trimitere de test.
update public.talant_test_scores s
set group_name = 'qa'
from auth.users u
where u.id = s.user_id and s.group_name = 'ci' and u.email <> 'ci@talant.app';

update public.talant_profiles p
set group_name = 'qa'
from auth.users u
where u.id = p.user_id and p.group_name = 'ci' and u.email <> 'ci@talant.app';

commit;
