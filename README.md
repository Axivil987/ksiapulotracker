# Ksiapulo Tracker

Nieoficjalna, fanowska mapa lokali z odcinków [Książula](https://www.youtube.com/@ksiazulo).
Wchodzisz → strona pyta o lokalizację (albo wpisujesz miasto/adres) → widzisz najbliższe miejsca,
z filtrem kategorii (kebab, pizza, burger, obiad…) i oceny (MUALA / na plus / na minus).

## Jak to działa

```
YouTube RSS kanału ──► GitHub Action co 15 min ──► scripts/update.mjs ──► data/*.json ──► strona (GitHub Pages)
                                                     │                                          │
                                                     ├─ yt-dlp: opis, rozdziały, napisy PL       └─ co 60 s sprawdza data/meta.json
                                                     ├─ Claude API: lokale, miasto, ocena            i pokazuje „nowy odcinek!”
                                                     └─ Nominatim (OSM): współrzędne
```

- **Strona** (`index.html`, `assets/`) to czysty HTML/JS bez budowania: Leaflet + MarkerCluster, mapa CARTO/OSM.
- **Na żywo:** przeglądarka co minutę pobiera `data/meta.json`. Gdy bot dopisze nowy odcinek, pojawia się
  powiadomienie i nowe pinezki (oznaczone „NOWE” przez 7 dni) bez odświeżania strony.
- **Świeżość danych:** u góry panelu jest data najnowszego zmapowanego odcinka, a przy każdym lokalu data
  odcinka, z którego pochodzi. Kropka „NA ŻYWO” pokazuje, kiedy bot ostatnio sprawdzał kanał.
- **Ekstrakcja:** z klucza `ANTHROPIC_API_KEY` Claude czyta tytuł, rozdziały opisu i automatyczne napisy,
  i zwraca lokale z miastem, kategorią i oceną. Bez klucza bot bierze tylko nazwy z rozdziałów — miasta nie zna,
  więc odcinek trafia do sekcji „w trakcie mapowania”, dopóki nie dodasz klucza albo poprawki ręcznie.

## Zgłoszenia błędów

W dymku każdego lokalu jest link „Zgłoś błąd”. Otwiera on gotowe zgłoszenie (issue) w repozytorium,
z nazwą lokalu, linkiem do odcinka i id wizyt. Poprawkę wpisujesz do `data/overrides.json` pod tym id.
Adres repozytorium ustawiasz w stałej `REPORT_URL` na górze `assets/app.js`.

Ten sam lokal odwiedzony w kilku odcinkach (np. weryfikacja MUALA) strona łączy w jedną pinezkę
z historią wizyt. Łączy po nazwie i mieście, bez wielkości liter i polskich znaków.

## Link do lokalu i aplikacja

Otwarty dymek zapisuje się w adresie (`#lokal=<nazwa>--<miasto>`), więc taki link otwiera ten lokal na mapie.
`manifest.webmanifest` i `sw.js` pozwalają zainstalować stronę jak aplikację. Service worker najpierw pyta sieć,
kopia służy tylko, gdy nie ma internetu. Kafelków mapy nie zapisuje.

## Pliki danych

| plik | co zawiera |
|---|---|
| `data/places.json` | pinezki na mapie |
| `data/videos.json` | stan każdego odcinka: `done`, `pending` (brak lokalizacji części lokali), `skipped`, `error` |
| `data/meta.json` | kiedy bot sprawdzał kanał, najnowszy odcinek, liczniki |
| `data/overrides.json` | ręczne poprawki: `{ "<id wizyty>": { "lat": 54.35, "lng": 18.64 } }`, `{ "<id>": { "closed": true } }` (lokal zamknięty) albo `{ "<id>": { "hidden": true } }` |
| `data/geocache.json` | cache geokodowania (żeby nie męczyć Nominatim) |
| `scripts/seed/*.json` | ręcznie spisane lokale (ten sam format co wynik Claude) |

## Uruchomienie lokalnie

```bash
npm install
npm run serve          # http://localhost:4173
npm run update         # sprawdź kanał teraz (wymaga yt-dlp: pip install yt-dlp)
```

Przydatne:

```bash
node scripts/update.mjs --backfill 50          # + 50 starszych filmów z historii kanału
node scripts/update.mjs --video 2gDf8XkwDmI    # przelicz jeden odcinek od nowa
node scripts/update.mjs --from-file scripts/seed/plik.json   # wczytaj ręcznie spisane lokale
```

## Wdrożenie (GitHub Pages)

1. Wrzuć repo na GitHub, w **Settings → Pages** wybierz „Deploy from a branch”, gałąź `main`, katalog `/`.
2. W **Settings → Secrets and variables → Actions** dodaj `ANTHROPIC_API_KEY`.
3. Workflow `.github/workflows/update.yml` startuje sam co 15 minut; pierwszy raz możesz go odpalić ręcznie
   (Actions → „Sprawdź nowe odcinki” → Run workflow, z `backfill` = np. 100, żeby zmapować całą historię).

Model ustawisz zmienną `KSIAPULO_MODEL` (domyślnie `claude-opus-5-5`). Zapytania mają włączony
server-side fallback (`fallbacks: "default"`), więc rzadkie odmowy modelu są automatycznie ponawiane na innym modelu.
Godzinny odcinek to ok. 15–25 tys. tokenów wejścia.

Jeśli YouTube zacznie blokować pobieranie napisów z serwerów GitHuba („Sign in to confirm you're not a bot”),
dodaj sekret `YT_COOKIES` z plikiem cookies w formacie Netscape — bez tego bot dalej działa, ale ma tylko tytuł i opis.

## Aplikacja na iPhone'a (sideload)

Aplikacja (Capacitor 8) wyświetla stronę z GitHub Pages, więc każda zmiana na stronie od razu jest w aplikacji.
Nowy plik `.ipa` trzeba zbudować tylko po zmianie ikony, nazwy, uprawnień albo `capacitor.config.json`.

- **Budowanie:** GitHub Actions → „Aplikacja iOS (plik .ipa)” → Run workflow (działa na Macu w chmurze GitHuba,
  dla publicznego repo za darmo). Wynik: artefakt `Ksiapulo-ipa` z plikiem `Ksiapulo.ipa` (bez podpisu).
- **Instalacja z Windowsa:** [Sideloadly](https://sideloadly.io) + iTunes i iCloud w wersji ze strony Apple (nie ze sklepu
  Microsoft). Podłącz iPhone'a kablem, przeciągnij `.ipa`, wpisz swoje Apple ID → Start.
  Na iPhonie: Ustawienia → Ogólne → VPN i urządzenia → zaufaj swojemu Apple ID; Ustawienia → Prywatność i ochrona →
  Tryb dewelopera → włącz.
- **Darmowe Apple ID:** aplikacja działa 7 dni, potem trzeba ją ponownie wgrać (Sideloadly umie to robić automatycznie).
  Konto Apple Developer (99 USD/rok) wydłuża to do roku.
- **Logowanie w aplikacji:** link z maila wraca do aplikacji przez adres `ksiapulo://auth`
  (dozwolony w Supabase → Authentication → URL Configuration).
- **Logo i ekran startowy:** `node scripts/brand.mjs` (wymaga `npm i --no-save @resvg/resvg-js`) generuje ikony strony
  oraz `resources/` dla aplikacji.

## Część społecznościowa (Supabase)

Konta, odhaczanie lokali (GPS + zdjęcie), rangi, odznaki, rankingi miast, aktywność jak na Stravie,
filmiki z opiniami i reakcje „MUALA”. Bez konfiguracji strona działa jako sama mapa.

- `supabase/schema.sql` — tabele, reguły dostępu i cała logika punktów. Punkty przyznaje tylko baza
  (funkcje `check_in`, `post_video`, `react`…), więc nie da się ich dopisać z przeglądarki.
- `supabase/places.sql` — lokale do bazy (generuje `node scripts/sync-places.mjs`).
- `supabase/functions/moderate` — opcjonalna moderacja zdjęć i filmików przez Claude.
- `assets/social.js` — interfejs, `assets/config.js` — adres i publiczny klucz projektu.

**Lista do odhaczenia** zależy tylko od miasta domowego: promień rośnie (15, 25, 40… km), aż w okolicy będzie
co najmniej 12 lokali. Dwie osoby z Tarnowskich Gór mają więc dokładnie tę samą listę (25 km).

**Ochrona przed oszustwami:** odhaczyć można tylko w promieniu 250 m od lokalu (4 km dla pinezek przybliżonych)
i tylko ze zdjęciem z aparatu. Do sprawdzenia trafiają odhaczenia z niemożliwą prędkością między lokalami,
ponad 10 na dobę, z tym samym zdjęciem co u kogoś innego albo ze słabym GPS. Filmik znika po 3 zgłoszeniach.
GPS da się sfałszować, dlatego zostają zdjęcia, panel moderacji i (opcjonalnie) AI.

### Uruchomienie krok po kroku

1. **Projekt:** załóż konto na [supabase.com](https://supabase.com) → New project (region Frankfurt).
2. **Baza:** SQL Editor → New query → wklej `supabase/schema.sql` → Run. Potem to samo z `supabase/places.sql`.
3. **Klucze:** Project Settings → API. `Project URL` i klucz `anon public` wpisz do `assets/config.js`.
   Klucza `service_role` nigdy nie wpisuj do plików strony.
4. **Logowanie e-mailem:** Authentication → URL Configuration → *Site URL* = adres strony
   (np. `https://twoj-login.github.io/ksiapulotracker/`), a w *Redirect URLs* dodaj też `http://localhost:4173/`.
5. **Logowanie przez Google:**
   - W [Google Cloud Console](https://console.cloud.google.com) (na wybranym przez ciebie koncie Google) utwórz projekt,
     skonfiguruj *OAuth consent screen* (typ External), potem *Credentials → Create credentials → OAuth client ID → Web application*.
   - W *Authorized redirect URIs* wklej adres callback z Supabase (Authentication → Providers → Google, pole *Callback URL*).
   - Client ID i Client Secret wklej w Supabase w tym samym miejscu i włącz providera.
6. **Admin:** zaloguj się na stronie, załóż profil, potem w SQL Editor:
   `update profiles set is_admin = true where username = 'twoja_nazwa';` — w zakładce *Ty* pojawi się *Panel moderacji*.
7. **Automatyczne wgrywanie nowych lokali:** w repo na GitHubie dodaj zmienną `SUPABASE_URL`
   (Settings → Secrets and variables → Actions → Variables) i sekret `SUPABASE_SERVICE_ROLE_KEY`.
8. **Zasady:** uzupełnij dane administratora i kontakt w `zasady.html`.

### Moderacja przez AI (opcjonalnie)

Funkcja `moderate` sprawdza każde nowe zdjęcie z odhaczenia (czy to jedzenie, a nie zdjęcie ekranu)
i kadr + opis każdego filmiku (treści dla dorosłych, hejt, spam). Podejrzane odhaczenie wraca do sprawdzenia
z cofniętymi punktami, a podejrzany filmik jest ukrywany — decyzję podejmujesz w panelu moderacji.
Claude nie ogląda całego filmu ani nie słyszy dźwięku, tylko kadr i opis.

```bash
npx supabase login
npx supabase functions deploy moderate --project-ref <id-projektu> --no-verify-jwt
npx supabase secrets set --project-ref <id-projektu> ANTHROPIC_API_KEY=... WEBHOOK_SECRET=<losowy-ciąg>
```

Potem Database → Webhooks → Create: tabela `checkins`, zdarzenie *Insert*, typ *Supabase Edge Function* → `moderate`,
nagłówek `x-webhook-secret` = ten sam losowy ciąg. Drugi taki sam webhook dla tabeli `videos`.
Model zmienisz sekretem `MODERATION_MODEL` (domyślnie `claude-opus-5-5`, niski wysiłek; jedno zdjęcie to ułamek grosza).

---

Strona nie jest powiązana z Książulo ani marką MUALA. Lokalizacje ustalane są automatycznie i mogą zawierać błędy.
