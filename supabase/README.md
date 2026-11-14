# Things i DailyPep Supabase

Alle objekter er isolert med prefikset `things_`. Migrasjonen gir ikke `anon`
eller `authenticated` direkte tabelltilgang. Nettleseren bruker bare Edge
Function-en `things-api`, som validerer en tilfeldig enhetsnøkkel før data leses
eller endres.

## Koble til DailyPep

1. Installer Supabase CLI og logg inn.
2. Koble repoet til riktig DailyPep-prosjekt:
   `supabase link --project-ref <DAILYPEP_PROJECT_REF>`
3. Kjør migrasjonen: `supabase db push`
4. Sett tillatt app-origin:
   `supabase secrets set THINGS_ALLOWED_ORIGIN=https://<things-domene>`
5. Publiser funksjonen:
   `supabase functions deploy things-api --no-verify-jwt`
6. Legg prosjektets URL og anon/publishable key i `site/.env.local`, basert på
   `site/.env.example`.

Service role-nøkkelen brukes bare av Supabase sitt servermiljø og skal aldri
legges i frontendens miljøfil.

