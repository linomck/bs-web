/**
 * N2nd - Express Server
 * Katalog + Serien-API, Stream-Resolver (CapSolver) und HLS-Proxy für den
 * standalone Burning-Series-Katalog & Player.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const { Agent, setGlobalDispatcher } = require('undici');

// Höhere Nebenläufigkeit für ausgehende fetch()-Requests (Katalog-Anreicherung
// lädt viele Serien-Seiten parallel). WICHTIG: pipelining MUSS 0 bleiben -
// mit pipelining=1 hat burningseries.cx bei hoher Parallelität Antworten
// vertauscht/verkürzt zurückgegeben (Titel korrekt, aber Beschreibung/Cover
// leer), da der Server offenbar kein sauberes HTTP-Pipelining unterstützt.
setGlobalDispatcher(new Agent({ connections: 40, pipelining: 0 }));

const db = require('./lib/db');
const scraper = require('./lib/bs-scraper');
const voe = require('./lib/voe');
const capsolver = require('./lib/capsolver');
const tvmaze = require('./lib/tvmaze');
const { handleHlsProxy } = require('./lib/hls-proxy');
const auth = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(auth.attachUser);
app.get('/auth/login', auth.login);
app.get('/auth/callback', auth.callback);
app.use(auth.requireUser);
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Katalog-Synchronisation (Hintergrund, TTL-gesteuert)
// ---------------------------------------------------------------------------
let catalogSyncInFlight = null;

async function ensureCatalogSynced() {
  if (!db.isCatalogStale()) return;
  if (catalogSyncInFlight) return catalogSyncInFlight;

  catalogSyncInFlight = (async () => {
    console.log('[Catalog] Synchronisiere Katalog von Burning Series...');
    try {
      const entries = await scraper.fetchCatalog();
      const added = db.insertNewSeries(entries);
      db.markCatalogSynced();
      console.log(`[Catalog] ${entries.length} Serien im Katalog, ${added} neu.`);
    } catch (err) {
      console.error('[Catalog] Sync fehlgeschlagen:', err.message);
    } finally {
      catalogSyncInFlight = null;
    }
  })();

  return catalogSyncInFlight;
}

// Hintergrund-Worker: reichert Serien ohne Metadaten nach und nach mit
// Beschreibung, Genres, Jahren und Cover an. Hohe Nebenläufigkeit (viele
// parallele Requests), da dies reines I/O ist und BS bislang keine
// spürbaren Rate-Limits zeigt. ~10.500 Serien sollen so in Minuten statt
// Stunden durchlaufen.
const ENRICH_CONCURRENCY = parseInt(process.env.ENRICH_CONCURRENCY, 10) || 12;
const enrichInFlight = new Set();
let enrichDone = 0;
let enrichActiveWorkers = 0;
const enrichRetryAfter = new Map(); // slug -> Zeitstempel (Netzwerkfehler-Cooldown)
let enrichConsecutiveNetFails = 0;
let enrichPausedUntil = 0;

function claimNextUnenriched() {
  // Holt eine Serie, die noch nicht angereichert ist und nicht gerade läuft.
  if (Date.now() < enrichPausedUntil) return null;
  const rows = db.db
    .prepare(`SELECT slug FROM series WHERE updated_at = 0 LIMIT ?`)
    .all(ENRICH_CONCURRENCY * 4 + enrichRetryAfter.size);
  const t = Date.now();
  for (const r of rows) {
    if (!enrichInFlight.has(r.slug) && (enrichRetryAfter.get(r.slug) || 0) <= t) {
      enrichInFlight.add(r.slug);
      return r.slug;
    }
  }
  return null;
}

async function enrichWorker() {
  enrichActiveWorkers++;
  try {
    for (;;) {
      const slug = claimNextUnenriched();
      if (!slug) return;
      try {
        const meta = await scraper.fetchSeries(slug);
        db.upsertSeries({ ...meta, updatedAt: Date.now() });
        db.registerSeasons(slug, meta.seasons || [1]);
        enrichRetryAfter.delete(slug);
        enrichConsecutiveNetFails = 0;
      } catch (err) {
        const reason = (err.cause && (err.cause.code || err.cause.message)) || err.message;
        if (/^HTTP 404/.test(err.message)) {
          // Serie existiert nicht (mehr): endgültig als erledigt markieren
          const ex = db.getSeries(slug);
          db.upsertSeries({ slug, title: ex && ex.title, updatedAt: Date.now() });
        } else {
          // Netzwerk-/Serverfehler: NICHT als angereichert speichern, später erneut versuchen
          enrichRetryAfter.set(slug, Date.now() + 5 * 60 * 1000);
          if (++enrichConsecutiveNetFails >= 10) {
            enrichPausedUntil = Date.now() + 60 * 1000;
            enrichConsecutiveNetFails = 0;
            console.warn(`[Enrich] Viele Netzwerkfehler (${reason}) - pausiere 60s`);
          }
        }
      } finally {
        enrichInFlight.delete(slug);
        if (++enrichDone % 200 === 0) {
          const remaining = db.db
            .prepare(`SELECT COUNT(*) AS c FROM series WHERE updated_at = 0`)
            .get().c;
          console.log(`[Enrich] ${enrichDone} fertig, verbleibend: ${remaining}`);
        }
      }
    }
  } finally {
    enrichActiveWorkers--;
  }
}

// Füllt den Worker-Pool kontinuierlich auf; jeder Worker zieht sofort die
// nächste Serie, sobald er fertig ist (kein Warten auf langsamste im Batch).
function enrichTick() {
  while (enrichActiveWorkers < ENRICH_CONCURRENCY) {
    const before = enrichActiveWorkers;
    enrichWorker();
    if (enrichActiveWorkers === before) break;
    // Worker beendet sich sofort, wenn nichts zu tun ist
    if (enrichInFlight.size === 0 && enrichActiveWorkers === 0) break;
  }
}

ensureCatalogSynced();
setInterval(() => ensureCatalogSynced(), 60 * 60 * 1000);
setInterval(enrichTick, 1000);

// ---------------------------------------------------------------------------
// API: Katalog
// ---------------------------------------------------------------------------
app.get('/api/catalog', async (req, res) => {
  await ensureCatalogSynced();
  const q = req.query.q || '';
  const genre = req.query.genre || '';
  const page = parseInt(req.query.page, 10) || 1;
  const pageSize = Math.min(96, parseInt(req.query.pageSize, 10) || 48);

  try {
    const result = db.searchCatalog({ q, genre, page, pageSize });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/genres', async (req, res) => {
  await ensureCatalogSynced();
  res.json(db.listGenres());
});

// ---------------------------------------------------------------------------
// API: Serien-Detail (Metadaten + Staffeln)
// ---------------------------------------------------------------------------
app.get('/api/series/:slug', async (req, res) => {
  const slug = req.params.slug;

  try {
    if (db.isSeriesStale(slug)) {
      const meta = await scraper.fetchSeries(slug);
      const tv = await tvmaze.fetchTvmazeMetadata(meta.title || slug);
      db.upsertSeries({
        ...meta,
        coverUrl: meta.coverUrl || (tv && tv.coverUrl) || null,
        updatedAt: Date.now(),
      });
      db.registerSeasons(slug, meta.seasons || [1]);
    }

    const series = db.getSeries(slug);
    if (!series) {
      res.status(404).json({ error: 'Serie nicht gefunden' });
      return;
    }
    const seasons = db.getSeasons(slug);
    res.json({ ...series, seasons: seasons.length ? seasons : [1] });
  } catch (err) {
    res.status(502).json({ error: 'Konnte Serie nicht laden: ' + err.message });
  }
});

// Lädt eine Staffel (falls veraltet/fehlend) von BS + TVmaze in die DB.
async function ensureSeasonLoaded(slug, season) {
  if (!db.isSeasonStale(slug, season)) return;
  const episodes = await scraper.fetchSeason(slug, season);

  const series = db.getSeries(slug);
  const tv = await tvmaze.fetchTvmazeMetadata((series && series.title) || slug);

  const enriched = episodes.map((ep) => {
    const tvEp = tv && tv.episodes ? tv.episodes[`${season}_${ep.number}`] : null;
    return {
      ...ep,
      thumbnail: ep.thumbnail || (tvEp && tvEp.thumbnail) || null,
      summary: ep.summary || (tvEp && tvEp.summary) || null,
    };
  });

  db.saveSeasonEpisodes(slug, season, enriched);

  if (tv && tv.coverUrl && series && !series.coverUrl) {
    db.upsertSeries({ ...series, coverUrl: tv.coverUrl, updatedAt: series.updatedAt });
  }
}

app.get('/api/series/:slug/season/:num', async (req, res) => {
  const { slug } = req.params;
  const season = parseInt(req.params.num, 10) || 1;

  try {
    await ensureSeasonLoaded(slug, season);

    res.json(db.getSeasonEpisodes(slug, season));
  } catch (err) {
    res.status(502).json({ error: 'Konnte Staffel nicht laden: ' + err.message });
  }
});

function findNextEpisode(slug, season, number) {
  const seasonEpisodes = db.getSeasonEpisodes(slug, season);
  const idx = seasonEpisodes.findIndex((e) => e.number === number);
  let next = idx >= 0 ? seasonEpisodes[idx + 1] : null;
  if (!next) {
    next = db.getSeasonEpisodes(slug, season + 1)[0] || null;
    if (next) next.season = season + 1;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Hybrid: Extension löst Stream beim Nutzer auf, Server liefert nur Metadaten
// und das reCAPTCHA-Ticket (CapSolver-Key bleibt serverseitig).
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({ hlsProxy: HLS_PROXY_ENABLED, extensionId: process.env.EXTENSION_ID || 'cglglgifbklakfciiiaoiaofldpckgoj' });
});

app.get('/api/episode-info', async (req, res) => {
  const { slug } = req.query;
  const season = parseInt(req.query.season, 10);
  const number = parseInt(req.query.episode, 10);
  if (!slug) {
    res.status(400).json({ error: 'slug fehlt.' });
    return;
  }
  let episode = db.getEpisode(slug, season, number);
  if (!episode || !episode.bsUrl) {
    try {
      await ensureSeasonLoaded(slug, season);
    } catch (err) {
      res.status(502).json({ error: 'Konnte Staffel nicht laden: ' + err.message });
      return;
    }
    episode = db.getEpisode(slug, season, number);
  }
  if (!episode || !episode.bsUrl) {
    res.status(404).json({ error: 'Episode nicht gefunden.' });
    return;
  }
  res.json({
    episode,
    episodeUrl: episode.voeUrl || episode.bsUrl,
    nextEpisode: findNextEpisode(slug, season, number),
    captchaToken: auth.createCaptchaToken(req.user),
  });
});

app.get('/api/me', (req, res) => {
  res.json({ name: req.user.name, email: req.user.email, picture: req.user.picture || null, authEnabled: auth.enabled });
});

// --- Verlauf / Weiterschauen (pro Nutzer) ---
app.get('/api/progress', (req, res) => {
  res.json(db.listProgress(req.user.sub, 20));
});

app.put('/api/progress', (req, res) => {
  const { slug } = req.body || {};
  const season = parseInt(req.body.season, 10);
  const episode = parseInt(req.body.episode, 10);
  const position = Number(req.body.position);
  const duration = Number(req.body.duration);
  if (!slug || !Number.isFinite(season) || !Number.isFinite(episode) || !Number.isFinite(position) || position < 0) {
    res.status(400).json({ error: 'Ungültige Daten.' });
    return;
  }
  db.saveProgress(req.user.sub, String(slug).slice(0, 200), season, episode, position, Number.isFinite(duration) ? duration : 0);
  res.json({ ok: true });
});

app.delete('/api/progress/:slug', (req, res) => {
  db.deleteProgress(req.user.sub, req.params.slug);
  res.json({ ok: true });
});

// --- Startseite ---
app.get('/api/home', async (req, res) => {
  await ensureCatalogSynced();
  try {
    const genres = db.listGenres(12).map((g) => g.genre);
    const picks = genres.sort(() => Math.random() - 0.5).slice(0, 4);
    res.json({
      hero: db.randomHero(),
      newest: db.newestSeries(20),
      rows: picks.map((g) => ({ genre: g, items: db.seriesByGenre(g, 20) })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const captchaHits = new Map(); // ip -> [timestamps]
app.options('/api/captcha', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.sendStatus(204);
});

app.post('/api/captcha', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!req.user && !auth.verifyCaptchaToken(bearer)) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return;
  }
  const { pageUrl, sitekey } = req.body || {};
  let host;
  try { host = new URL(pageUrl).hostname; } catch (e) { /* ungültig */ }
  const allowed = [scraper.PRIMARY_BASE, scraper.FALLBACK_BASE].map((b) => new URL(b).hostname);
  if (!host || !allowed.includes(host) || !/^6L[\w-]{30,}$/.test(sitekey || '')) {
    res.status(400).json({ error: 'Ungültige pageUrl/sitekey.' });
    return;
  }

  const ip = req.ip;
  const now = Date.now();
  const hits = (captchaHits.get(ip) || []).filter((t) => now - t < 60 * 1000);
  if (hits.length >= 10) {
    res.status(429).json({ error: 'Zu viele Captcha-Anfragen.' });
    return;
  }
  hits.push(now);
  captchaHits.set(ip, hits);

  try {
    res.json({ ticket: await capsolver.solveRecaptchaV2(pageUrl, sitekey) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// HLS Proxy
// ---------------------------------------------------------------------------
const HLS_PROXY_ENABLED = process.env.HLS_PROXY === '1';
if (HLS_PROXY_ENABLED) {
  app.get('/api/hls', handleHlsProxy);
} else {
  app.get('/api/hls', (req, res) => res.status(404).json({ error: 'HLS-Proxy deaktiviert (HLS_PROXY=1 zum Aktivieren).' }));
}

// ---------------------------------------------------------------------------
// Fallback: SPA-Routen (Katalog/Serie/Watch) direkt auf index.html je Seite
// ---------------------------------------------------------------------------
app.get('/serie/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'series.html'));
});
app.get('/watch', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

app.listen(PORT, () => {
  console.log(`[BS-Web] Server läuft auf http://localhost:${PORT}`);
});
