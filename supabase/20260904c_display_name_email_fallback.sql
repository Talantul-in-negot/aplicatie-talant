-- Talant: un cont creat direct din Supabase Dashboard, fără câmpul de
-- metadata completat (username), primea numele generic "Utilizator" în
-- clasament, fixat definitiv de la prima salvare de scor. Interfața
-- Dashboard-ului nu mai expune ușor acel câmp, deci fallback-ul se schimbă:
-- dacă nu există user_metadata.username, se deduce din partea de dinaintea
-- lui @ din email (la fel cum face deja pagina, în auth.js, doar vizual, la
-- afișare — acum se întâmplă și pe server, o singură dată, la alocare).
-- "Utilizator" rămâne doar ultimul fallback, pentru cazul (practic imposibil)
-- în care nici emailul nu există.
begin;

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
  v_wanted := left(initcap(split_part(
    coalesce(
      nullif(trim(auth.jwt() -> 'user_metadata' ->> 'username'), ''),
      nullif(trim(auth.jwt() ->> 'email'), ''),
      'Utilizator'
    ), '@', 1)), 30);
  if nullif(trim(v_wanted), '') is null then v_wanted := 'Utilizator'; end if;
  v_candidate := v_wanted;
  loop
    begin
      insert into public.talant_profiles (user_id, user_name, group_name) values (v_user_id, v_candidate, v_group);
      return v_candidate;
    exception when unique_violation then
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
