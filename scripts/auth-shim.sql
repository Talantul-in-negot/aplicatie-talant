-- Reproduce local doar suprafața Supabase de care depind migrările: schema
-- auth, rolurile anon/authenticated și funcțiile auth.uid()/auth.jwt() citite
-- din claims-urile cererii. Nu face parte din aplicație — este folosit exclusiv
-- de scripts/verify-migrations.js.
create schema if not exists auth;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

-- Ajutor de test: „autentifică" o sesiune psql ca un cont existent, cu
-- user_metadata luat din auth.users (exact ce pune Supabase în JWT).
create or replace function auth.sign_in_as(p_email text) returns uuid
language plpgsql as $$
declare v_user auth.users;
begin
  select * into v_user from auth.users where email = p_email;
  if v_user.id is null then raise exception 'No such test user: %', p_email; end if;
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_user.id::text, 'email', v_user.email,
                       'user_metadata', v_user.raw_user_meta_data)::text, false);
  return v_user.id;
end;
$$;

create or replace function auth.sign_out() returns void
language sql as $$ select set_config('request.jwt.claims', '', false); $$;
