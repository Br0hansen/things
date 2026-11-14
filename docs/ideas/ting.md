# Things

En installérbar webapp for to personer som deler kjøkken.

## Problem

Hvordan kan to personer sette status på en vare i det de ser den, med én hånd, så den andre handler ut fra den statusen?

## Hvem

Et par som handler sammen. Begge kan alt. Det finnes ingen roller.

## Suksess

Status blir satt mens skapdøren er åpen. Etter 14 dager hos dere skal de fleste endringene ha skjedd der, ikke i sofaen etterpå.

## Retning

Skapet er forsiden. Der ligger alle varene dere følger med på, alfabetisk, også de som står som Har. Handlelista er et utsnitt av samme vare:

- Har tar varen av lista
- Snart tom legger den under Kan tas med
- Tom legger den under Må kjøpes

Avkrysning i butikken setter varen tilbake til Har. En ny vare starter som Tom. Partner blir med via én lenke.

Katalogen er varene som pleier å gå tomme, typisk 15–30 stykker. Den vokser når noen oppdager en vare, ikke ved å føre hele huset.

## Enhåndsbruk

Telefonen holdes i én hånd. Tommelen skal nå hvert valg som setter eller fjerner en status, uten å flytte grepet.

- Primære handlinger ligger i tommelsonen, nederst på skjermen.
- Treffflater for status og avkrysning er minst 56 piksler høye og går i full bredde, så både venstre og høyre hånd når dem.
- Trykk på en vare åpner et bunnark med Har, Snart tom og Tom. Valget skal ikke ligge langt oppe i lista.
- Bunnarket lukkes med et mål i selve arket. Å treffe det mørke feltet øverst er ikke lukkemåten.
- Lista blafrer med tommelen. Det er hovedmåten å finne en vare på.
- Søk ligger slik at det kan nås med tommelen, og er veien inn når varen mangler. Tastatur fra systemet er unntaket der fingrene skriver.
- Ingenting viktig ligger i øvre hjørne. Ingen ikon uten tekst. Ingen drag som krever presisjon. Ingen tofingergester.

## Delt hjem

Ett hjem. To navn. Siste endring vinner når begge treffer samme vare. Appen skal kunne brukes i butikken uten dekning, og hente seg inn når telefonen er på nett igjen.

I DailyPep ligger dette i tre egne tabeller:

- `ting_homes` er hjemmet og invitasjonskoden
- `ting_members` er de to personene. Koden sendes med når partner blir med, og lagres ikke
- `ting_items` er én rad per vare, med tilstand `have`, `soon` eller `empty`

En eldre `updated_at` overskriver ikke en nyere vare.

Push-varsel er ute. Den som handler åpner lista selv.

## Første versjon

- Skapet med alle fulgte varer
- Tre tilstander i et bunnark
- Handle med Må kjøpes og Kan tas med
- Avkrysning som setter Har
- Legge til vare som Tom
- Invitasjon av én person
- Installérbar webapp som lagrer lokalt og synker hjem, medlemmer og varer

Teknisk utgangspunkt til noen endrer det bevisst: få avhengigheter, og siste endring vinner per vare. Ikke innfør et tungt rammeverk for å komme i gang.

## Det vi lar ligge

- Antall og mengde
- Rom og steder som struktur
- Roller, barnelogin og flere hjem
- Strekkode, utløpsdato, oppskrifter, budsjett og produktkatalog
- Push-varsel
- Forslag om at en vare «pleier å gå tom på torsdag»

## Åpent

- Om det holder med ett delt hjem og to navn, eller om hver person skal ha egen konto
- Om begge telefonene skal med fra første uke
- Det endelige navnet er Things.
