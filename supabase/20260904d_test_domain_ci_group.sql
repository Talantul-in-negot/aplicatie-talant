-- Talant: conturile pe domeniul @test.com intră automat în grupa `ci`, fără
-- să mai fie nevoie de un `insert into talant_group_members` manual de
-- fiecare dată când un cont de test e șters și recreat.
--
-- E sigur, spre deosebire de vechea regulă bazată pe domeniu eliminată în
-- 20260903_harden_identity_groups_attempts.sql: acolo elevii își puteau
-- alege singuri orice email la înregistrare, deci și domeniul de grupă.
-- Acum signUp() (auth.js) construiește mereu adresa pe @talant.app — niciun
-- elev nu poate ajunge vreodată pe @test.com prin formular, doar un cont
-- creat manual din Dashboard. Regula nu se aplică dacă există deja o
-- intrare explicită în talant_group_members (aceea are mereu prioritate).
begin;

create or replace function public.talant_user_group()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select m.group_name from public.talant_group_members m where m.user_id = auth.uid()),
    case when lower(auth.jwt() ->> 'email') like '%@test.com' then 'ci' end,
    'general');
$$;

commit;
