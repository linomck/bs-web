# N2nd

Standalone Katalog & Player für Burning Series — kein Browser-Plugin nötig.
Portiert aus der `bs-autowatch` Chrome-Extension (siehe `../AGENTS.md` für die
Kernkonzepte: MKGMa-Dekodierung, Invarianten, Liquid-Glass-Design).

## Features

- **Katalog** (`/`): Alle ~10.600 BS-Serien, Live-Suche, Genre-Filter, Cover-Grid.
- **Serien-Detail** (`/serie/:slug`): Beschreibung, Genres, Cast, Staffel-Tabs,
  Episodenliste mit TVmaze-Thumbnails/Summaries.
- **Player** (`/watch?slug=...&season=...&episode=...`): hls.js-Player im
  Liquid-Glass-Design, Auto-Next mit Countdown, Episoden-Drawer, Tastatur-Shortcuts
  (Space/K Play-Pause, N Skip, E Episoden, F Vollbild, M Mute, Pfeiltasten).
- **Server-seitige Stream-Auflösung**: BS-Episodenseite → CapSolver (reCAPTCHA v2)
  → `embed.php` → VOE-Link → MKGMa-Dekodierung → M3U8.
- **Direkt-CDN-Wiedergabe mit Proxy-Fallback**: Der Player versucht zuerst, die
  M3U8/Segmente direkt vom VOE-CDN zu laden (kein Server-Traffic). Schlägt das
  fehl (z.B. IP-Bindung der signierten URL bei abweichender Client-IP), wechselt
  er automatisch auf `/api/hls`, das serverseitig proxied.
- **SQLite-Cache** mit TTLs (Katalog 24h, Serie/Staffel 12h, Stream 15min).

## Setup

```bash
cd web
npm install
cp .env.example .env
# .env ausfüllen: CAPSOLVER_API_KEY=... (siehe https://capsolver.com)
npm start
```

Server läuft auf `http://localhost:3000` (Port via `PORT` in `.env` änderbar).

Beim ersten Start wird der komplette Katalog von `burningseries.cx/andere-serien`
synchronisiert (~10.600 Einträge) und dann im Hintergrund mit Beschreibung,
Genres, Jahren und Cover angereichert (Nebenläufigkeit über `enrichBatch` in
`server.js` einstellbar, Standard: 30 parallele Requests alle 500ms).

## Architektur

```
web/
  server.js            Express-Routen, Katalog-Sync, Hintergrund-Anreicherung
  lib/
    db.js               SQLite-Schema (better-sqlite3) + TTL-Helper
    bs-scraper.js        Katalog/Serie/Staffel/Episodenseite scrapen (cheerio)
    voe.js               MKGMa-Decoder + VOE-Redirect-Gate
    capsolver.js         ReCaptchaV2TaskProxyLess: createTask + Polling
    tvmaze.js            TVmaze-Anreicherung (Cover, Episoden-Thumbnails)
    hls-proxy.js         Playlist-Rewrite + Segment-Streaming (Fallback-Pfad)
  public/
    index.html/js/css    Katalog
    series.html/js/css   Serien-Detail
    watch.html/js/css    Player
    theme.css            Geteiltes Liquid-Glass-Theme
    hls.min.js           hls.js (Kopie aus ../player/)
  data/bs.db             SQLite-Datenbank (gitignored)
```

## API-Endpunkte

| Route | Beschreibung |
|---|---|
| `GET /api/catalog?q=&genre=&page=&pageSize=` | Katalog-Suche/Filter/Pagination |
| `GET /api/genres` | Top-Genres mit Anzahl |
| `GET /api/series/:slug` | Serien-Metadaten + Staffelliste |
| `GET /api/series/:slug/season/:n` | Episodenliste (mit Thumbnails/Summaries) |
| `POST /api/resolve` `{slug, season, episode}` | Löst Episode zu M3U8 auf (CapSolver!) |
| `POST /api/preload` `{slug, season, episode}` | Löst nächste Folge im Hintergrund auf (fire-and-forget) |
| `GET /api/preload/status?slug=&season=&episode=` | Pollt, ob Preload fertig ist |
| `GET /api/hls?u=<base64url>` | Proxy-Fallback für Playlists/Segmente |

## Wichtige Implementierungsdetails

- **Cookie-Jar für `embed.php`**: BS setzt DDoS-Guard-Cookies (`__ddg*`,
  `__bsduid`) beim Laden der Episodenseite, die `embed.php` zur Validierung
  erwartet. `bs-scraper.js` sammelt diese via `extractCookies()`/`cookieHeader()`
  ein und schickt sie beim POST an `embed.php` mit — ohne das schlägt die
  Anfrage mit HTTP 400 fehl.
- **TVmaze-Titel-Bereinigung**: BS listet oft mehrere Titel getrennt durch
  `" | "` (z.B. `"Game of Thrones | GoT"`). TVmaze's `singlesearch` findet
  damit nichts — `tvmaze.js` probiert daher jeden Titel-Teil einzeln.
- **`updated_at`-Fallback-Falle**: `entry.updatedAt || now()` behandelt `0` als
  falsy — daher explizit `entry.updatedAt != null ? entry.updatedAt : now()`
  verwenden, sonst werden frisch katalogisierte Serien fälschlich sofort als
  "bereits angereichert" markiert.
- **Absolute Asset-Pfade**: Alle `<link>`/`<script>`-Referenzen in `public/*.html`
  müssen mit `/` beginnen. Unter verschachtelten Routen wie `/serie/:slug` lösen
  relative Pfade sonst falsch auf (Browser interpretiert `:slug` als Verzeichnis).
- **`undici`-Agent für Nebenläufigkeit**: `pipelining` MUSS `0` bleiben. Mit
  `pipelining=1` hat `burningseries.cx` bei hoher Parallelität Antworten
  vertauscht/verkürzt zurückgegeben (Titel korrekt geparst, aber Beschreibung/
  Cover leer) — der Server unterstützt offenbar kein sauberes HTTP-Pipelining.

## Bekannte Einschränkungen

- **CapSolver-Kosten**: Jede neu aufgelöste Episode kostet eine
  reCAPTCHA-v2-Lösung (~0,8 ct). Stream-Cache (15min TTL) und Preloading halten
  die Anzahl niedrig, aber ein produktiver Einsatz mit vielen Nutzern sollte das
  Budget im Blick behalten.
- **Anti-Bot-Risiko bei Cloud-Hosting**: BS nutzt DDoS-Guard-Cookies. Rechenzentrums-IPs
  (AWS/GCP/Azure/Hetzner etc.) werden von solchen Systemen tendenziell strenger
  geprüft als Heimnetz-IPs. Vor produktivem Einsatz auf dem Ziel-Host testen.
- **Direkt-CDN-Fallback ungetestet über echte IP-Grenzen hinweg**: Die
  Direkt-Wiedergabe wurde nur von derselben Maschine wie der Server aus
  getestet (CORS ist offen, aber ob die signierte URL wirklich IP-gebunden
  ist, lässt sich nur mit einem echten anderen Client-Netzwerk verifizieren).
  Der automatische Fallback auf `/api/hls` fängt das ab, falls es fehlschlägt.
