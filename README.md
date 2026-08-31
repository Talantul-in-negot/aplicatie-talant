# Talant — aplicația de teste

Aplicație statică pentru testele Samuel și quiz-ul Ioan, cu autentificare,
scorare verificată în Supabase și clasament separat pe grupe.

## Structură canonică

- `index.html` este singura implementare a testelor Samuel și pagina servită la `/`.
- `1samuel-test.html` este doar un alias care redirecționează către `/`, păstrând query-ul `?test=...`.
- `quiz.html` conține quiz-ul Ioan.
- `build-site.js` servește aceeași pagină `index.html` la `/` și în build-ul Cloudflare.

Nu copia logica Samuel într-o a doua pagină. `npm test` verifică automat această regulă.

## Verificare locală

```powershell
npm ci
npm test
npm run build
```

Testele validează toate întrebările, sintaxa scripturilor inline, contractele RPC,
rutele canonice și faptul că fiecare răspuns corect din frontend există în migrarea
server-side.

## Supabase

Baza live este considerată baselined până la `20260823`. Migrațiile noi se adaugă
în `supabase/migrations.txt`, în ordinea execuției. Workflow-ul
`Apply Supabase migrations` le rulează tranzacțional și înregistrează fiecare fișier
în `public.talant_migration_history`, astfel încât nu este executat de două ori.

Configurează în GitHub, la **Settings → Secrets and variables → Actions**, secretul:

- `SUPABASE_DB_URL` — connection string-ul PostgreSQL al proiectului Supabase.

Migrarea `20260824_secure_scoring.sql` mută validarea răspunsurilor pe server și
înlocuiește în siguranță vechile semnături RPC.

## Publicare și verificare live

GitHub Pages publică automat branch-ul `main`, folderul `/(root)`. Workflow-ul
`Quality and live verification` rulează testele înainte de verificarea publicării,
așteaptă până când pagina publică livrează scorarea `v2`, apoi execută testul live.

Pentru testul end-to-end creează un cont Supabase dedicat CI și configurează secretele:

- `TALANT_E2E_EMAIL`
- `TALANT_E2E_PASSWORD`

Contul trebuie folosit numai pentru CI. Testul autentifică acel cont, trimite un
rezultat corect pentru `samuel1-3-v2`, verifică scorul returnat de RPC și confirmă
apariția în clasamentul grupei. ID-ul încercării este stabil, deci rerulările nu
creează încercări duplicate.

Testul poate fi executat și local, după setarea variabilelor de mediu:

```powershell
npm run test:e2e
```
