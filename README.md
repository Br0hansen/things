# Things

Things er en lokal-først PWA for to personer som deler kjøkken. Appen har et
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
2. Kjør `supabase db push` fra repoets rot.
3. Sett `THINGS_ALLOWED_ORIGIN` som Supabase-secret.
4. Kjør `supabase functions deploy things-api --no-verify-jwt`.
5. Kopier `site/.env.example` til `site/.env.local` og fyll inn DailyPep-prosjektets
   URL og anon/publishable key.

Service role-nøkkelen skal aldri inn i `site/.env.local` eller frontendkoden.
Direkte klienttilgang til `things_*`-tabellene er sperret med RLS; all tilgang
går gjennom Edge Function-en etter validering av en hash-lagret enhetsnøkkel.

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


