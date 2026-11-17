# Things

Things er en lokal-først PWA for opptil seks personer som deler kjøkken. Appen har et
én-håndsgrensesnitt for statusene `Har`, `Snart tom` og `Tom`, og lager
handlelisten fra de samme varene.

## Kjør lokalt

```bash
cd site
npm install
npm run dev
```

Uten Supabase-miljøvariabler kjører appen i lokal modus med IndexedDB. Dette er
nyttig for utvikling og designkontroll, men partnerinvitasjon og synk er da
deaktivert.

## Koble til DailyPep Supabase

Alle databaseobjekter er avgrenset med `things_`-prefiks. Migrasjonen ligger i
[`supabase/migrations/202611140001_things_schema.sql`](supabase/migrations/202611140001_things_schema.sql),
og Edge Function-en ligger i [`supabase/functions/things-api`](supabase/functions/things-api).

1. Koble Supabase CLI til DailyPep-prosjektet.
2. Kjør `supabase db push` fra repoets rot. Migrasjon `003` legger til det
   bakoverkompatible Auth-grunnlaget uten å fjerne eksisterende enhetsnøkler.
3. Sett `THINGS_ALLOWED_ORIGIN=https://br0hansen.github.io` som Supabase-secret.
   For strekkodeoppslag setter du også
   `supabase secrets set KASSAL_API_KEY=<nøkkel fra kassal.app/profil/api>`.
   Kassal kalles høyst 5 ganger per minutt totalt for alle brukere. Treff lagres i
   den delte produktdatabasen `things_products` og slås ikke opp hos Kassal igjen.
4. Kjør `supabase functions deploy things-api --no-verify-jwt`. JWT-verifisering
   gjøres inne i funksjonen i hybridperioden, fordi gamle enheter fortsatt må virke.
5. Under **Authentication → URL Configuration** setter du Site URL til
   `https://br0hansen.github.io/things/` og legger til både produksjonsadressen og
   `http://127.0.0.1:5173/things/` som tillatte redirect-adresser.
6. Kopier `site/.env.example` til `site/.env.local` og fyll inn DailyPep-prosjektets
   URL og anon/publishable key.

Service role-nøkkelen skal aldri inn i `site/.env.local` eller frontendkoden.
Direkte klienttilgang til `things_*`-tabellene er sperret med RLS. Nye brukere
logger inn med Supabase Auth. Eksisterende medlemmer kan koble en gyldig
enhetsnøkkel til kontoen sin uten å miste hjem eller varer.

## Verifisering

```bash
cd site
npm test
npm run build
```

Produksjonsbygget skrives til `site/dist`.

## GitHub Pages

Repoet publiseres fra GitHub Actions-workflowen
`.github/workflows/pages.yml`. Den bygger appen med base path `/things/` og
publiserer `site/dist` til:

`https://br0hansen.github.io/things/`

I GitHub må **Settings → Pages → Source** være satt til **GitHub Actions**.


