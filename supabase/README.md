# Things i DailyPep Supabase

Alle objekter er isolert med prefikset `things_`. Migrasjon `003` legger til
`things_users`, medlemsroller og kobling til Supabase Auth. Eksisterende
enhetsnøkler beholdes midlertidig slik at dagens hjem kan migreres uten datatap.

## Koble til DailyPep

1. Installer Supabase CLI og logg inn.
2. Koble repoet til riktig DailyPep-prosjekt:
   `supabase link --project-ref <DAILYPEP_PROJECT_REF>`
3. Kjør migrasjonen: `supabase db push`
4. Sett tillatt app-origin:
   `supabase secrets set THINGS_ALLOWED_ORIGIN=https://br0hansen.github.io`
   Sett nøkkelen for strekkodeoppslag:
   `supabase secrets set KASSAL_API_KEY=<nøkkel fra kassal.app/profil/api>`
   Kassal kalles høyst 5 ganger per minutt totalt for alle brukere. Uten nøkkel
   virker skanning fortsatt, men bare mot produkter som allerede er lagret.
5. Sett Auth Site URL til `https://br0hansen.github.io/things/` og tillat samme
   redirect-URL samt `http://127.0.0.1:5173/things/` for lokal utvikling.
   Innlogging skjer med engangskode, fordi en installert iOS-app og Safari
   ikke deler innloggingsøkt. Under Authentication → Email Templates må både
   «Magic Link» og «Confirm signup» inneholde koden, for eksempel:
   `<p>Koden din er <strong>{{ .Token }}</strong></p>`.
6. Publiser funksjonen:
   `supabase functions deploy things-api --no-verify-jwt`
7. Legg prosjektets URL og anon/publishable key i `site/.env.local`, basert på
   `site/.env.example`.

`--no-verify-jwt` er nødvendig mens gamle enheter støttes. Nye Auth-handlinger
validerer tilgangstokenet inne i Edge Function-en. Service role-nøkkelen brukes
bare av Supabase sitt servermiljø og skal aldri legges i frontendens miljøfil.

