# AGENTS.md — BS Autowatch

Architektur-, Entwicklungs- und Betriebsdokumentation für Entwickler und AI-Agents, die an diesem Projekt arbeiten.

---

## 1. Projektübersicht

`bs-autowatch` ist eine Chrome Extension (Manifest V3), die das Streamen von Serien auf Burning Series (`burningseries.cx`, `bs.to`) über den Video-Hoster VOE automatisiert. Sie extrahiert HLS Master-Playlists (`.m3u8`), bietet einen integrierten Liquid-Glass-Player und lädt Folge-Episoden im Hintergrund geräuschlos vor.

---

## 2. Kernkomponenten & Datenfluss

```
[Burning Series Episode Page]
         │ (LID + Token + reCAPTCHA v2)
         ▼
[content/bs.js + capsolver-helper.js]
         │ POST /ajax/embed.php (ticket, LID, token)
         ▼
[VOE Hoster URL (z.B. voe.sx/e/... oder dynamische Domain)]
         │ JS Gate Redirect / HTML
         ▼
[content/voe.js] ─── Decodes MKGMa ───► M3U8 Master Playlist URL
         │                                    │
         ▼                                    ▼
[background.js] ────────── Opens ────────► [player/player.html]
         │                                    │
   (Silent Fetch)                             │ (Autoplay / Skip 'N')
         │                                    ▼
[Preloaded Next M3U8] ◄────────────── BSEpisodeCache (Local DB)
```

---

## 3. Kritische Invarianten & Schutzmechanismen

### 3.1. Keine Browser-Tabs für das Preloading öffnen
- **Regel:** Das Vorladen der nächsten Folge im Hintergrund (`preloadNextEpisodeSilently`) darf **niemals** über `chrome.tabs.create()` erfolgen.
- **Grund:** Würde ein Tab geöffnet, würde auf ihm `content/bs.js` starten, welches wiederum Popups öffnet und eine unkontrollierte Kaskade (Fork-Bomb) auslöst, bis der Browser crasht.
- **Lösung:** Reines HTTP-`fetch()` im Service Worker mit direkter `MKGMa`-Dekodierung.

### 3.2. WebRequest Feedback-Loop verhindern
- **Regel:** In `background.js` muss `chrome.webRequest.onBeforeRequest` Anfragen des Players selbst (`tabId === activePlayerTabId`) **strikt ignorieren**.
- **Grund:** `hls.js` im Player lädt kontinuierlich `.m3u8`-Playlists und Segmente herunter. Würde der Listener diese abfangen, würde er fälschlicherweise annehmen, ein neuer Hoster-Stream sei gefunden worden, und den Player endlos neu laden.

### 3.3. Vollständige URL-Slugs bei Burning Series
- **Regel:** BS-Episoden-URLs dürfen **niemals** rein nummerisch generiert werden (z.B. `/1/2/de/VOE` ist ungültig). Sie müssen zwingend den Episodennamen im Slug enthalten (z.B. `/1/2-Episode-Titel/de/VOE`).
- **Lösung:** `content/episode-cache.js` scrapt die Staffel-Seite (`/serie/<slug>/<season>/de`) und sichert die exakten Slugs aus `table.episodes` in `chrome.storage.local`.

### 3.4. Zufällige VOE-Domains & Frame-Isolation
- **Regel:** `content/voe.js` läuft auf `<all_urls>`, da VOE dynamisch wechselnde Domains verwendet.
- **Schutz:** Es muss zwingend `if (window.top !== window.self) return;` enthalten sein, um zu verhindern, dass Ad-Iframes mehrfach feuern.

### 3.5. Design-Richtlinie: Liquid Glass (Kein Orange)
- **Vorgabe:** Kein `#ff9800`, keine grellen Farben.
- **Stil:** Monochrom, transluzentes Acryl / Frosted Glass (`backdrop-filter: blur(25px - 40px) saturate(180%)`), subtile Kanten-Highlights (`border: 1px solid rgba(255, 255, 255, 0.16)`), weiße Akzente.

---

## 4. MKGMa-Entschlüsselungsalgorithmus

VOE bettet Videodaten in einem verschleierten String ein (`MKGMa="..."` oder `<script type="application/json">...`):
1. **ROT13**: Buchstabenverschiebung um 13 Stellen.
2. **Underscores entfernen**: `.replace(/_/g, '')`.
3. **Base64 Decode**: `atob()`.
4. **Shift (-3)**: Jedes Zeichen um `charCodeAt(0) - 3` dekrementieren.
5. **Reverse**: `.split('').reverse().join('')`.
6. **Base64 Decode**: `atob()`.
7. **JSON Parse**: Liefert `{ source: "https://...m3u8", direct_access_url: "https://...mp4" }`.

---

## 5. TVmaze API Integration

- **Endpoint:** `https://api.tvmaze.com/singlesearch/shows?q={query}&embed=episodes`
- **Nutzung:** Kostenlos, ohne API-Key, ohne Authentifizierung.
- **Mapping:** Extrahiert `image.medium` für Serien-Cover und Folgenthumbnails (`${season}_${number}`) und reichert die lokal gecachten Episodenobjekte an.

---

## 6. Build & Test

- **Syntaxprüfung aller Scripts:**
  ```bash
  node --check background.js content/*.js player/player.js popup/popup.js
  ```
- **HLS.js Abhängigkeit:**
  Liegt offlinefähig in `player/hls.min.js`.
