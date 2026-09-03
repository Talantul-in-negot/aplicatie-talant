# Audit de securitate — remediere

Toate constatările din auditul din 3 septembrie 2026, cu starea lor.

## Critice

- [x] **Baremele erau publicate.** `https://.../supabase/20260824_secure_scoring.sql`
      răspundea 200 cu 52 KB de chei. GitHub Pages publică din `/(root)`.
      → `_config.yml` exclude `supabase/`, `scripts/`, `db/`, PDF-urile și utilitarele.
      → `verify-project.js` verifică lista; `e2e-live.js` verifică 404 pe site-ul real.
- [x] **Grupa era auto-atribuită.** `talant_user_group()` deducea grupa din domeniul
      emailului, iar `signUp` accepta un email complet ales de utilizator.
      → grupa vine din `talant_group_members`, scris doar prin service role;
      `signUp` refuză adresele complete.

## Ridicate

- [x] **Clasament „farmabil".** Fără plafon de încercări, se păstra maximul.
      → `talant_quiz_settings.scored_attempts` (implicit 1); se punctează primele N
      încercări; restul rămân în jurnal. Pagina cere confirmare înainte de trimitere.
- [x] **Impersonare prin nume afișat.** `user_name` venea din `user_metadata`,
      rescriptibil de utilizator cu cheia anon.
      → `talant_profiles` fixează numele la prima folosire, cu index unic.

## Medii

- [x] Dependență CDN nefixată, fără SRI → `@2.114.0` + `integrity` + `crossorigin`.
- [x] Fără antete de securitate → CSP în `<meta>` (Pages) și antete complete în Worker.
- [x] Generatorul de migrări lipsea → `scripts/generate-secure-scoring-migration.js`,
      verificat byte-cu-byte în `npm test`.
- [x] `verify-project.js` prindea doar cheile lipsă → acum egalitate exactă de mulțimi,
      plus detectarea dublurilor și a valorilor greșite de punctaj.
- [x] CI polua clasamentul de producție → contul de CI stă în grupa `ci`;
      `e2e-live.js` refuză să treacă dacă nu este configurat.
- [x] Recuperarea parolei imposibilă → nu se poate rezolva în cod; documentat explicit
      în README ca decizie de luat înainte de concurs.

## Mici

- [x] `startTest` cădea pe `'samuel1-2'`, un id inexistent → cade pe selector.
- [x] Service worker nu precacha `index.html`; `CACHE_NAME` bumpat la `talant-v3`.
- [x] Cache busting inconsistent (`?v=1` / `?v=3`) → `?v=4` peste tot.
- [x] `@anthropic-ai/sdk` era `dependency` → mutat în `devDependencies`.
- [x] `apply-migrations.js` interpola numele fișierului în SQL → `-v name=` + `:'name'`.

## Găsite în timpul remedierii

- [x] **`apply-migrations.js` nu elimina niciodată `begin;`/`commit;`.** Regexul era
      ancorat la începutul fișierului, dar toate migrările încep cu comentarii, deci
      `commit;`-ul din fișier închidea tranzacția `-1` a lui psql *înainte* de
      înregistrarea în `talant_migration_history` — o migrare putea rămâne aplicată,
      dar neînregistrată. Acum se elimină ca linii de sine stătătoare.
- [x] **Conturile cu nume din două cuvinte nu se puteau autentifica.** `signUp` crea
      adresa cu spațiu (`ana maria@…`), iar `loginEmails` o căuta cu underscore
      (`ana_maria@…`). Ambele trec acum prin `accountLocalPart`.

## Verificare

- `npm test` — 558 întrebări, contracte RPC, excluderi de publicare, CDN fixat,
  1062 chei de răspuns cu potrivire exactă, migrare generată identic.
- `npm run test:db` — 9 migrări aplicate pe Postgres 16 curat, 13 verificări
  funcționale (plafon, nume fixat, izolare pe grupe, refuzuri de acces).
- `npm run build` — bundle-ul Worker conține doar cele 30 de fișiere ale aplicației.

## De făcut manual, o singură dată

1. Revizuiește `talant_group_members` — cine s-a înscris singur cu `@test.com`
   înainte de întărire este încă în grupa `biserica`.
2. Pune contul de CI în grupa `ci` (comanda este în README și în mesajul de eroare
   al testului live).
3. Decide politica de resetare a parolelor înainte de concurs.
