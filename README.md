# Talant — aplicația de teste

Aplicație statică pentru testele Samuel și quiz-ul Ioan, cu autentificare,
scorare verificată pe server în Supabase și clasament separat pe grupe.

## Structură canonică

- `index.html` este singura implementare a testelor Samuel și pagina servită la `/`.
- `1samuel-test.html` este doar un alias care redirecționează către `/`, păstrând query-ul `?test=...`.
- `quiz.html` conține quiz-ul Ioan.
- `build-site.js` servește aceeași pagină `index.html` la `/` și în build-ul Cloudflare.
- `scripts/quiz-catalog.js` este sursa unică pentru lista de teste și pentru cheile
  de răspuns derivate din `data/`. `npm test` verifică faptul că lista din
  `index.html` este identică cu ea.

Nu copia logica Samuel într-o a doua pagină. `npm test` verifică automat această regulă.

## Verificare locală

```powershell
npm ci
npm test
npm run test:db
npm run build
```

`npm test` validează întrebările, sintaxa scripturilor inline, contractele RPC,
rutele canonice, faptul că dependența externă este fixată cu `integrity`, faptul
că `_config.yml` ține baremele în afara site-ului public și că fiecare cheie de
răspuns din migrare corespunde exact fișierelor din `data/` (fără chei lipsă,
duplicate sau rămase în urmă).

`npm run test:db` aplică toate migrările pe un Postgres de unică folosință
(Docker, sau `TALANT_TEST_DB_URL` în CI) și verifică garanțiile pe care se
sprijină clasamentul. Fără Docker și fără `TALANT_TEST_DB_URL`, se auto-omite.

## Ce nu trebuie publicat

GitHub Pages publică repo-ul din `/(root)`, deci **orice fișier commis devine
public**. `_config.yml` exclude `supabase/` (baremele complete ale tuturor
testelor), `scripts/`, `db/`, PDF-urile din `data/` și utilitarele Node.
`e2e-live.js` confirmă pe site-ul publicat că `/supabase/...` răspunde 404.

Baremele rămân totuși vizibile în `data/*.js`, pentru că pagina afișează
răspunsul corect în raportul de final. Scorul însă se calculează exclusiv pe
server, din `talant_quiz_answer_keys` / `talant_test_answer_keys`.

## Supabase

Baza live este considerată baselined până la `20260823`. Migrațiile noi se adaugă
în `supabase/migrations.txt`, în ordinea execuției. Workflow-ul
`Apply Supabase migrations` întâi le rulează pe o bază curată (`npm run test:db`),
apoi le aplică tranzacțional în producție și înregistrează fiecare fișier în
`public.talant_migration_history`, astfel încât nu este executat de două ori.

Configurează în GitHub, la **Settings → Secrets and variables → Actions**, secretul:

- `SUPABASE_DB_URL` — connection string-ul PostgreSQL al proiectului Supabase.

`20260824_secure_scoring.sql` mută validarea răspunsurilor pe server.
Fișierul este generat: `npm run keys:generate` îl rescrie din `questions.js` și
`data/`, iar `npm test` verifică faptul că nu a divergat. Migrarea este deja
aplicată, deci **nu o edita** — cheile corectate se adaugă într-o migrare nouă.

`20260903_harden_identity_groups_attempts.sql` închide trei căi prin care
clasamentul putea fi manipulat din browser. Este strict aditivă: nu șterge nicio
încercare și niciun scor.

### Nume afișate

Numele din clasament se fixează la prima salvare de scor, în `talant_profiles`,
și este unic. Anterior era citit din `user_metadata.username`, pe care orice cont
și-l poate rescrie singur cu cheia publică — deci un elev putea apărea sub numele
altuia. Dacă două conturi vechi împărțeau același nume, primul îl păstrează, iar
al doilea primește un sufix (`Ana 2`) la următoarea salvare.

Redenumire administrativă:

```sql
update public.talant_profiles set user_name = 'Nume Nou' where user_id = '<id>';
```

### Grupe

Grupa nu mai este dedusă din domeniul emailului — utilizatorul își alegea singur
adresa la înregistrare, deci putea intra singur în clasamentul bisericii.
Apartenența se citește acum din `talant_group_members`, care se scrie **doar**
din SQL Editor / service role; niciun RPC nu poate scrie acolo.

```sql
-- Mută un cont în grupa bisericii (implicit toți ceilalți sunt în 'general').
insert into public.talant_group_members (user_id, group_name)
values ('<id-ul contului>', 'biserica')
on conflict (user_id) do update set group_name = excluded.group_name;

-- Cine în ce grupă este:
select p.user_name, m.group_name from public.talant_group_members m
join public.talant_profiles p using (user_id) order by m.group_name, p.user_name;
```

Migrarea a populat o singură dată grupa `biserica` din vechea regulă, ca membrii
actuali să nu fie mutați. **Verifică lista o dată** — dacă cineva se înscrisese
singur cu un email `@test.com` înainte de întărire, este încă acolo și trebuie
scos manual. `talant_church_domains` rămâne în bază doar ca urmă istorică și nu
mai influențează nimic.

### Încercări punctate

Doar primele N încercări intră în clasament (implicit **1**). Reluările
ulterioare rămân în jurnal pentru audit, dar nu mai pot urca scorul. Pagina cere
confirmare înainte de trimitere și spune a câta încercare punctată este.

```sql
-- Valoarea implicită pentru toate testele:
update public.talant_quiz_settings set scored_attempts = 2 where quiz_version = '*';

-- Excepție pentru un singur test:
insert into public.talant_quiz_settings (quiz_version, scored_attempts)
values ('samuel1-3-v2', 3)
on conflict (quiz_version) do update set scored_attempts = excluded.scored_attempts;
```

Schimbarea plafonului nu necesită deploy: scorurile se recalculează la
următoarea salvare a fiecărui elev.

## Publicare și verificare live

GitHub Pages publică automat branch-ul `main`, folderul `/(root)`. Workflow-ul
`Quality and live verification` rulează testele și verificările de bază de date
înainte de verificarea publicării, așteaptă până când pagina publică livrează
scorarea `v2`, apoi execută testul live.

Pentru testul end-to-end creează un cont Supabase dedicat CI și configurează secretele:

- `TALANT_E2E_EMAIL`
- `TALANT_E2E_PASSWORD`

Contul trebuie folosit numai pentru CI și trebuie pus într-o grupă proprie, ca
scorul lui să nu apară în clasamentul elevilor la fiecare push:

```sql
insert into public.talant_group_members (user_id, group_name)
values ('<id-ul contului de CI>', 'ci')
on conflict (user_id) do update set group_name = excluded.group_name;
```

Testul refuză să treacă dacă acest pas lipsește. El verifică apoi că baremele nu
sunt publicate, autentifică contul, trimite un rezultat corect pentru
`samuel1-3-v2`, verifică scorul returnat de RPC și confirmă apariția în
clasamentul grupei izolate. ID-ul încercării este stabil, deci rerulările nu
creează încercări duplicate.

```powershell
npm run test:e2e
```

## Politica de resetare a parolei

Conturile folosesc adrese sintetice `@talant.app`, care nu ajung nicăieri, iar
confirmarea prin email este dezactivată — Supabase nu poate trimite un email de
resetare. **Decizie: resetare manuală, de către administrator.** Elevii își aleg
singuri numele de utilizator și parola la înregistrare, ca până acum; o parolă
uitată se rezolvă exclusiv prin Supabase Dashboard:

1. **Authentication → Users**, caută contul după numele de utilizator (partea
   dinaintea lui `@talant.app`) sau `@test.com` pentru conturile de grupă.
2. Deschide contul → **Reset password** → setează o parolă nouă.
3. Comunică elevului noua parolă pe alt canal (nu există niciun mecanism automat
   care s-o trimită).

Are nevoie de un administrator cu acces la Supabase Dashboard disponibil (măcar
contactabil) pe durata concursului. Nu este nevoie de nicio modificare de cod —
fluxul de autentificare rămâne cel curent.
