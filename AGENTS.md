# AGENTS.md — N2nd (Nightsecond)

Architektur-, Entwicklungs- und Betriebsdokumentation für Entwickler und AI-Agents, die an diesem Projekt arbeiten.

---

## 1. Projektübersicht

**Namensgebung:** Die App und die Extension heißen beide **N2nd** (lange Form: **Nightsecond**). Technische Bezeichner (`n2nd`, Docker-Service/Volume, Paketname) heißen ebenfalls `n2nd`.

Dieses Repo enthält `n2nd` (N2nd): einen standalone Katalog & Player für Burning Series (`burningseries.cx`, Fallback `bs.to`), der Streams über den Hoster VOE serverseitig auflöst. Es ist ein Node/Express-Server mit SQLite-Cache und einem Liquid-Glass-Frontend (Vanilla JS + hls.js). Kein Browser-Plugin nötig.

Historie: Das Projekt entstand als Chrome Extension (Manifest V3, `bs-autowatch`) und wurde zur Web-App portiert. Die Extension-Dateien (`background.js`, `content/`, `player/`, `popup/`) sind **nicht mehr** Teil dieses Repos. Die Invarianten (MKGMa, Slugs, Design) gelten sinngemäß weiter.

Repo-Layout:

```
docker-compose.yml     Deployment hinter bestehendem Traefik (externes Netzwerk)
.env.example           DOMAIN, TRAEFIK_*, CAPSOLVER_API_KEY, BS_BASE_URL, BS_FALLBACK_URL
extension/             MV3-Extension "N2nd" (manifest.json, background.js)
web/
  server.js            Express-Routen, Katalog-Sync, Enrich-Worker-Pool
  lib/
    db.js              SQLite (better-sqlite3, WAL, FTS5) + TTLs
    bs-scraper.js      Katalog/Serie/Staffel/Episode scrapen (cheerio, undici)
    capsolver.js       reCAPTCHA v2 (ReCaptchaV2TaskProxyLess)
    voe.js             VOE-Redirect-Gate + MKGMa-Decoder
    tvmaze.js          TVmaze-Anreicherung
    auth.js            OIDC-Login (Pocket ID), Sessions, Captcha-Token
    hls-proxy.js       Playlist-Rewrite + Segment-Proxy (/api/hls)
  public/              index / series / watch (html, js, css), theme.css, hls.min.js
  data/bs.db           SQLite-DB (gitignored, Docker-Volume n2nd-data -> /app/data)
```

---

## 2. Datenfluss

```
Browser ── POST /api/resolve {slug, season, episode}
   │
   ▼
server.js: resolveEpisodeStream()
   │  1. Stream-Cache (streams-Tabelle, TTL 15min)
   │  2. bs-scraper: Episodenseite laden (LID, Token, DDoS-Guard-Cookies)
   │  3. capsolver: reCAPTCHA v2 lösen
   │  4. POST /ajax/embed.php (mit Cookie-Jar) -> VOE-Link
   │  5. voe.js: Gate-Redirect folgen, MKGMa dekodieren -> M3U8
   ▼
Antwort: { m3u8 (Proxy-URL), directM3u8, episode, nextEpisode, cached }
   │
   ▼
Player (hls.js): zuerst directM3u8; bei Fehler Fallback auf /api/hls?u=<base64url>
```

### 2a. Hybrid-Modus (Extension)
Ist die Extension installiert, löst sie den Stream auf der IP des Nutzers auf; der Server liefert nur Metadaten und das Captcha-Ticket:
```
watch.js ── GET /api/episode-info ──► {episodeUrl, nextEpisode}
         ── chrome.runtime.sendMessage(extId, {type:'resolve', episodeUrl})
extension: Episodenseite (Cookie-Jar des Browsers) -> POST {server}/api/captcha (CapSolver) -> embed.php -> VOE -> MKGMa -> M3U8
watch.js ── hls.js direkt aufs VOE-CDN (Proxy /api/hls bleibt Fallback)
```
Das VOE-CDN sendet keine CORS-Header; die Extension ergänzt sie per `declarativeNetRequest` (`extension/rules.json`, nur für Requests mit Initiator `stream.n2nd.de`/`localhost`). Bei anderer Domain `initiatorDomains` anpassen.
Ohne Extension oder bei Fehler: Fallback auf `POST /api/resolve` (alles serverseitig). `GET /api/config` liefert die Extension-ID (Env `EXTENSION_ID`, Default = ID aus dem `key` im Manifest). `externally_connectable` in `extension/manifest.json` muss die Web-Domain enthalten. `/api/captcha` ist auf BS-Hosts + Sitekey-Format beschränkt und rate-limitiert (10/min/IP). Preload läuft im Hybrid-Modus clientseitig über die Extension. Installation: `chrome://extensions` -> Entwicklermodus -> "Entpackte Erweiterung laden" -> `extension/`.

API-Endpunkte: `GET /api/catalog`, `GET /api/genres`, `GET /api/series/:slug`, `GET /api/series/:slug/season/:num`, `POST /api/resolve`, `POST /api/preload`, `GET /api/preload/status`, `GET /api/hls`, `GET /api/config`, `GET /api/episode-info`, `POST /api/captcha`. Seiten: `/`, `/serie/:slug`, `/watch`.

### 2b. Login & Nutzer (`lib/auth.js`)
Die App macht den OIDC-Login (Pocket ID, Authorization-Code + PKCE) selbst; die Traefik-Middleware `pocketid-auth` wird für N2nd **nicht** benutzt. Routen: `/auth/login`, `/auth/callback`. Sessions liegen in SQLite (`sessions`, Cookie `n2nd_sid`, 30 Tage). Env: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REQUIRED_GROUP` (optional), `SESSION_SECRET`, `PUBLIC_URL` (aus `DOMAIN`). Redirect-URI im Pocket-ID-Client: `https://<DOMAIN>/auth/callback`. Ohne `OIDC_ISSUER` ist Auth aus und der Nutzer ist `local`.
`/api/captcha` wird von der Extension aufgerufen (ohne Session-Cookie) und ist über ein kurzlebiges HMAC-Token geschützt: `/api/episode-info` liefert `captchaToken`, die Extension sendet es als `Authorization: Bearer`.
Pro Nutzer: Tabelle `watch_progress` (eine Zeile pro Serie), API `GET/PUT /api/progress`, `DELETE /api/progress/:slug`, `GET /api/me`. Startseite: `GET /api/home` (Hero, Neu, Genre-Reihen). Der Player speichert alle 15 s und stellt über `&t=<Sekunden>` wieder her.

---

## 3. Kritische Invarianten & Schutzmechanismen

### 3.1. Preloading nur per HTTP
- `POST /api/preload` löst die nächste Folge fire-and-forget über `resolveEpisodeStream()` auf (reines `fetch()`, kein Browser/Tab, kein Headless-Browser). Status wird über `/api/preload/status` gepollt. Jede Auflösung kostet eine CapSolver-Lösung (~0,8 ct) — Stream-Cache und Preload-Deduplizierung nicht umgehen.

### 3.2. undici `pipelining` MUSS `0` bleiben
- Mit `pipelining=1` vertauschte/verkürzte `burningseries.cx` bei hoher Parallelität Antworten (Titel ok, Beschreibung/Cover leer).

### 3.3. Cookie-Jar für `embed.php`
- BS setzt DDoS-Guard-Cookies (`__ddg*`, `__bsduid`) beim Laden der Episodenseite; `embed.php` validiert sie. `bs-scraper.js` sammelt sie (`extractCookies()`/`cookieHeader()`) und sendet sie mit, sonst HTTP 400.

### 3.4. Vollständige URL-Slugs bei Burning Series
- Episoden-URLs dürfen nie rein nummerisch gebaut werden (`/1/2/de/VOE` ungültig); sie brauchen den Episodennamen (`/1/2-Episode-Titel/de/VOE`). Slugs werden aus `table.episodes` der Staffelseite gescrapt und in der `episodes`-Tabelle (`bs_url`) gespeichert.

### 3.5. Katalog-Anreicherung (Enrich)
- `series.updated_at = 0` bedeutet "noch nicht angereichert". Beim Katalog-Sync werden nur **neue** Serien eingefügt (`db.insertNewSeries`), bestehende nicht zurückgesetzt.
- Nie `entry.updatedAt || now()` verwenden (`0` ist falsy) — `entry.updatedAt != null ? entry.updatedAt : now()`.
- Worker-Pool (`ENRICH_CONCURRENCY`, Default 12, per Env): HTTP 404 -> endgültig als erledigt markieren; Netzwerk-/Serverfehler -> NICHT als angereichert speichern, 5 min Cooldown pro Slug, nach 10 Fehlern in Folge 60 s globale Pause.

### 3.6. Frontend-Pfade
- Alle `<link>`/`<script>`-Referenzen in `public/*.html` müssen mit `/` beginnen (sonst falsche Auflösung unter `/serie/:slug`).

### 3.7. Direkt-CDN mit Proxy-Fallback
- Der Player lädt zuerst direkt vom VOE-CDN (kein Server-Traffic) und fällt bei Fehler automatisch auf `/api/hls` zurück, das Playlists umschreibt (alle URIs wieder über den Proxy) und Segmente streamt. Signierte URLs könnten IP-gebunden sein — den Fallback nicht entfernen. Der Proxy ist aktuell per Default **deaktiviert** (`/api/hls` -> 404, Client ohne Fallback); Aktivierung mit Env `HLS_PROXY=1` (`/api/config` meldet `hlsProxy`).

### 3.8. Design-Richtlinie: Liquid Glass (Kein Orange)
- Kein `#ff9800`, keine grellen Farben. Monochrom, transluzentes Acryl (`backdrop-filter: blur(25px - 40px) saturate(180%)`), Kanten-Highlight `border: 1px solid rgba(255, 255, 255, 0.16)`, weiße Akzente. Geteiltes Theme in `public/theme.css`.

---

## 4. MKGMa-Entschlüsselungsalgorithmus (`lib/voe.js`)

VOE bettet Videodaten in einem verschleierten String ein (`MKGMa="..."` oder `<script type="application/json">...`):
1. **ROT13**
2. **Underscores entfernen**: `.replace(/_/g, '')`
3. **Base64 Decode**
4. **Shift (-3)**: jedes Zeichen `charCode - 3`
5. **Reverse**
6. **Base64 Decode**
7. **JSON Parse**: `{ source: "https://...m3u8", direct_access_url: "https://...mp4" }`

---

## 5. Caching (SQLite, `lib/db.js`)

Tabellen: `series` (+ FTS5 `series_fts`), `seasons`, `episodes`, `streams`, `meta`. TTLs: Katalog 24h, Serie 1 Jahr, Staffel 7 Tage, Stream 15 min. Der Katalog (~10.600 Serien) wird beim Start und stündlich synchronisiert.

TVmaze (`https://api.tvmaze.com/singlesearch/shows?q=...&embed=episodes`, kein API-Key): liefert Cover, Episoden-Thumbnails und Summaries. BS-Titel mit `" | "` werden in Teile gesplittet und einzeln gesucht.

---

## 6. Konfiguration & Betrieb

- Env: `PORT` (3000), `CAPSOLVER_API_KEY` (Pflicht für `/api/resolve`), `BS_BASE_URL`, `BS_FALLBACK_URL`, `ENRICH_CONCURRENCY`.
- Lokal: `cd web && npm install && npm start` (`npm run dev` mit `--watch`). Node >= 18.
- Docker: `docker compose up -d --build` im Repo-Root. Das Image läuft als Nicht-Root-User; Daten im Volume `n2nd-data`. Traefik-Labels erwarten ein externes Netzwerk (`TRAEFIK_NETWORK`) und `DOMAIN`.
- Syntaxprüfung:
  ```bash
  cd web && node --check server.js lib/*.js public/*.js
  ```
- Secrets (`.env`, `CAPSOLVER_API_KEY`) nie committen.
