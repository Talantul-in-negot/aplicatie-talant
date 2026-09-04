-- Redenumește manual cele două conturi de test, ca "Test" să treacă de la
-- contul mai vechi (test@test.com, creat probabil direct din Dashboard) la
-- contul folosit efectiv la login (test@talant.app), fără să ștergem niciunul.
-- Ordinea contează: numele e unic (index pe lower(user_name)), deci trebuie
-- eliberat "test" înainte să-l putem da celuilalt cont.
begin;

update public.talant_profiles set user_name = 'Test (vechi)'
  where user_id = '5c35e049-8e1e-40aa-a1ac-4a3c02fac9c7'; -- test@test.com
update public.talant_profiles set user_name = 'Test'
  where user_id = 'e02cffef-4395-457d-8a59-465e4ba138cd'; -- test@talant.app

-- talant_scores / talant_test_scores țin o copie a numelui, actualizată în mod
-- normal doar la următoarea trimitere de scor — o aliniem acum, ca schimbarea
-- să se vadă imediat în clasament, nu abia la următorul test dat.
update public.talant_scores set user_name = 'Test (vechi)' where user_id = '5c35e049-8e1e-40aa-a1ac-4a3c02fac9c7';
update public.talant_scores set user_name = 'Test' where user_id = 'e02cffef-4395-457d-8a59-465e4ba138cd';
update public.talant_test_scores set user_name = 'Test (vechi)' where user_id = '5c35e049-8e1e-40aa-a1ac-4a3c02fac9c7';
update public.talant_test_scores set user_name = 'Test' where user_id = 'e02cffef-4395-457d-8a59-465e4ba138cd';

commit;

-- Verificare:
select user_id, user_name from public.talant_profiles where user_id in (
  '5c35e049-8e1e-40aa-a1ac-4a3c02fac9c7', 'e02cffef-4395-457d-8a59-465e4ba138cd'
);
