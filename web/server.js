/**
 * BS Web - Express Server
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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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
      db.upsertSeriesBulk(entries.map((e) => ({ slug: e.slug, title: e.title, updatedAt: 0 })));
      db.markCatalogSynced();
      console.log(`[Catalog] ${entries.length} Serien synchronisiert.`);
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
let enrichRunning = false;
async function enrichBatch(limit = 30) {
  if (enrichRunning) return;
  enrichRunning = true;
  try {
    const rows = db.db
      .prepare(`SELECT slug FROM series WHERE updated_at = 0 LIMIT ?`)
      .all(limit);
    if (rows.length === 0) return;

    await Promise.allSettled(
      rows.map(async (row) => {
        try {
          const meta = await scraper.fetchSeries(row.slug);
          db.upsertSeries({ ...meta, updatedAt: Date.now() });
          db.registerSeasons(row.slug, meta.seasons || [1]);
        } catch (err) {
          db.upsertSeries({ slug: row.slug, title: row.slug, updatedAt: Date.now() });
          console.warn(`[Enrich] Fehler bei '${row.slug}':`, err.message);
        }
      })
    );

    const remaining = db.db.prepare(`SELECT COUNT(*) AS c FROM series WHERE updated_at = 0`).get().c;
    console.log(`[Enrich] Batch fertig (${rows.length} Serien), verbleibend: ${remaining}`);
  } finally {
    enrichRunning = false;
  }
}

ensureCatalogSynced();
setInterval(() => ensureCatalogSynced(), 60 * 60 * 1000);
setInterval(() => enrichBatch(30), 500);

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

app.get('/api/series/:slug/season/:num', async (req, res) => {
  const { slug } = req.params;
  const season = parseInt(req.params.num, 10) || 1;

  try {
    if (db.isSeasonStale(slug, season)) {
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

    res.json(db.getSeasonEpisodes(slug, season));
  } catch (err) {
    res.status(502).json({ error: 'Konnte Staffel nicht laden: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Stream-Resolver (Episodenseite -> CapSolver -> embed.php -> VOE -> M3U8)
// ---------------------------------------------------------------------------
async function resolveEpisodeStream(slug, season, number) {
  const episode = db.getEpisode(slug, season, number);
  if (!episode || !episode.bsUrl) {
    throw new Error('Episode nicht im Cache gefunden. Bitte zuerst Staffel laden.');
  }

  const cacheKey = `${slug}_${season}_${number}`;
  const cached = db.getCachedStream(cacheKey);
  if (cached) {
    return { m3u8: cached, episode, cached: true };
  }

  const voeUrl = episode.voeUrl || episode.bsUrl;
  const page = await scraper.fetchEpisodePage(voeUrl);

  if (!page.lid) {
    throw new Error('data-lid nicht gefunden. Ist der VOE-Hoster verfügbar?');
  }
  if (!page.sitekey) {
    throw new Error('reCAPTCHA-Sitekey nicht gefunden.');
  }
  if (!capsolver.isConfigured()) {
    throw new Error('CAPSOLVER_API_KEY ist nicht konfiguriert (siehe web/.env.example).');
  }

  const ticket = await capsolver.solveRecaptchaV2(page.pageUrl, page.sitekey);

  const embedResp = await fetch(new URL('/ajax/embed.php', page.pageUrl).href, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: page.pageUrl,
      'User-Agent': scraper.UA,
      Cookie: scraper.cookieHeader(page.cookies),
    },
    body: new URLSearchParams({ LID: page.lid, ticket, token: page.token }).toString(),
  });
  const embedText = await embedResp.text();
  let embedData;
  try {
    embedData = JSON.parse(embedText);
  } catch (e) {
    throw new Error(`embed.php antwortete unerwartet (HTTP ${embedResp.status}): ${embedText.slice(0, 200) || '(leer)'}`);
  }

  if (!embedData || !embedData.link) {
    throw new Error('Kein VOE-Link von embed.php erhalten: ' + JSON.stringify(embedData));
  }

  const m3u8 = await voe.resolveVoeStream(embedData.link);
  if (!m3u8) {
    throw new Error('Konnte M3U8 nicht aus dem VOE-Stream extrahieren.');
  }

  db.setCachedStream(cacheKey, m3u8);
  return { m3u8, episode, cached: false };
}

app.post('/api/resolve', async (req, res) => {
  const { slug, season, episode } = req.body || {};
  if (!slug || !season || !episode) {
    res.status(400).json({ error: 'slug, season und episode sind erforderlich.' });
    return;
  }

  try {
    const result = await resolveEpisodeStream(slug, parseInt(season, 10), parseInt(episode, 10));

    const seasonEpisodes = db.getSeasonEpisodes(slug, parseInt(season, 10));
    const currentIdx = seasonEpisodes.findIndex((e) => e.number === parseInt(episode, 10));
    let next = currentIdx >= 0 ? seasonEpisodes[currentIdx + 1] : null;
    if (!next) {
      const nextSeasonEpisodes = db.getSeasonEpisodes(slug, parseInt(season, 10) + 1);
      next = nextSeasonEpisodes[0] || null;
      if (next) next.season = parseInt(season, 10) + 1;
    }

    res.json({
      m3u8: '/api/hls?u=' + Buffer.from(result.m3u8, 'utf8').toString('base64url'),
      directM3u8: result.m3u8,
      episode: result.episode,
      nextEpisode: next,
      cached: result.cached,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Preload: löst die nächste Folge im Hintergrund auf (Cache befüllen), OHNE
// einen Browser-Tab zu öffnen (Invariante 3.1: nur reines fetch()). Der
// eigentliche CapSolver-Vorgang dauert 10-40s, daher antwortet die Route
// sofort und der Fortschritt wird über /api/preload/status gepollt.
const preloadErrors = new Map(); // cacheKey -> Fehlermeldung

app.post('/api/preload', async (req, res) => {
  const { slug, season, episode } = req.body || {};
  if (!slug || !season || !episode) {
    res.status(400).json({ error: 'slug, season und episode sind erforderlich.' });
    return;
  }

  const cacheKey = `${slug}_${season}_${episode}`;
  preloadErrors.delete(cacheKey);

  resolveEpisodeStream(slug, parseInt(season, 10), parseInt(episode, 10)).catch((err) => {
    console.warn('[Preload] Fehlgeschlagen:', err.message);
    preloadErrors.set(cacheKey, err.message);
  });

  res.json({ status: 'preloading' });
});

app.get('/api/preload/status', (req, res) => {
  const { slug, season, episode } = req.query;
  if (!slug || !season || !episode) {
    res.status(400).json({ error: 'slug, season und episode sind erforderlich.' });
    return;
  }

  const cacheKey = `${slug}_${season}_${episode}`;
  const cached = db.getCachedStream(cacheKey);
  if (cached) {
    res.json({ ready: true });
    return;
  }
  if (preloadErrors.has(cacheKey)) {
    res.json({ ready: false, error: preloadErrors.get(cacheKey) });
    return;
  }
  res.json({ ready: false });
});

// ---------------------------------------------------------------------------
// HLS Proxy
// ---------------------------------------------------------------------------
app.get('/api/hls', handleHlsProxy);

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
