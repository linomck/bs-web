/**
 * N2nd - SQLite Datenbank & Cache
 * Schema für Katalog, Serien, Staffeln, Episoden und aufgelöste Streams.
 * TTLs steuern, wann Daten erneut gescraped werden.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'bs.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS series (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    cover_url TEXT,
    genres TEXT,
    years TEXT,
    cast TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS series_fts USING fts5(
    slug UNINDEXED,
    title,
    content='series',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS series_ai AFTER INSERT ON series BEGIN
    INSERT INTO series_fts(rowid, slug, title) VALUES (new.rowid, new.slug, new.title);
  END;

  CREATE TRIGGER IF NOT EXISTS series_ad AFTER DELETE ON series BEGIN
    INSERT INTO series_fts(series_fts, rowid, slug, title) VALUES('delete', old.rowid, old.slug, old.title);
  END;

  CREATE TRIGGER IF NOT EXISTS series_au AFTER UPDATE ON series BEGIN
    INSERT INTO series_fts(series_fts, rowid, slug, title) VALUES('delete', old.rowid, old.slug, old.title);
    INSERT INTO series_fts(rowid, slug, title) VALUES (new.rowid, new.slug, new.title);
  END;

  CREATE TABLE IF NOT EXISTS seasons (
    slug TEXT NOT NULL,
    season INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (slug, season),
    FOREIGN KEY (slug) REFERENCES series(slug) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS episodes (
    slug TEXT NOT NULL,
    season INTEGER NOT NULL,
    number INTEGER NOT NULL,
    title TEXT,
    bs_url TEXT,
    voe_url TEXT,
    thumbnail TEXT,
    summary TEXT,
    PRIMARY KEY (slug, season, number),
    FOREIGN KEY (slug) REFERENCES series(slug) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS streams (
    cache_key TEXT PRIMARY KEY,
    m3u8 TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    sub TEXT NOT NULL,
    name TEXT,
    email TEXT,
    groups TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS watch_progress (
    user_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    position REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, slug)
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// --- TTL Konstanten (Millisekunden) ---
const TTL = {
  CATALOG: 24 * 60 * 60 * 1000,
  // Serien-Metadaten ändern sich kaum -> lokal dauerhaft behalten (1 Jahr)
  SERIES: 365 * 24 * 60 * 60 * 1000,
  SEASON: 7 * 24 * 60 * 60 * 1000,
  STREAM: 15 * 60 * 1000,
};

function now() {
  return Date.now();
}

// --- Meta Helpers ---
function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// --- Series Helpers ---
const upsertSeriesStmt = db.prepare(`
  INSERT INTO series (slug, title, description, cover_url, genres, years, cast, updated_at)
  VALUES (@slug, @title, @description, @cover_url, @genres, @years, @cast, @updated_at)
  ON CONFLICT(slug) DO UPDATE SET
    title = excluded.title,
    description = COALESCE(NULLIF(excluded.description, ''), series.description),
    cover_url = COALESCE(NULLIF(excluded.cover_url, ''), series.cover_url),
    genres = COALESCE(NULLIF(excluded.genres, ''), series.genres),
    years = COALESCE(NULLIF(excluded.years, ''), series.years),
    cast = COALESCE(NULLIF(excluded.cast, ''), series.cast),
    updated_at = excluded.updated_at
`);

function upsertSeries(entry) {
  upsertSeriesStmt.run({
    slug: entry.slug,
    title: entry.title || entry.slug,
    description: entry.description || '',
    cover_url: entry.coverUrl || '',
    genres: entry.genres ? JSON.stringify(entry.genres) : '',
    years: entry.years || '',
    cast: entry.cast ? JSON.stringify(entry.cast) : '',
    updated_at: entry.updatedAt != null ? entry.updatedAt : now(),
  });
}

const insertNewSeriesStmt = db.prepare(
  `INSERT INTO series (slug, title, updated_at) VALUES (?, ?, 0) ON CONFLICT(slug) DO NOTHING`
);

// Katalog-Sync: nur NEUE Serien anlegen, bestehende (angereicherte) bleiben unberührt.
function insertNewSeries(entries) {
  let added = 0;
  const tx = db.transaction((rows) => {
    for (const r of rows) added += insertNewSeriesStmt.run(r.slug, r.title || r.slug).changes;
  });
  tx(entries);
  return added;
}

function upsertSeriesBulk(entries) {
  const tx = db.transaction((rows) => {
    for (const row of rows) upsertSeries(row);
  });
  tx(entries);
}

function getSeries(slug) {
  const row = db.prepare('SELECT * FROM series WHERE slug = ?').get(slug);
  if (!row) return null;
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    coverUrl: row.cover_url,
    genres: row.genres ? JSON.parse(row.genres) : [],
    years: row.years,
    cast: row.cast ? JSON.parse(row.cast) : [],
    updatedAt: row.updated_at,
  };
}

function isSeriesStale(slug) {
  const row = db.prepare('SELECT updated_at FROM series WHERE slug = ?').get(slug);
  if (!row) return true;
  return now() - row.updated_at > TTL.SERIES;
}

function isCatalogStale() {
  const ts = getMeta('catalog_synced_at');
  if (!ts) return true;
  return now() - Number(ts) > TTL.CATALOG;
}

function markCatalogSynced() {
  setMeta('catalog_synced_at', now());
}

function searchCatalog({ q, genre, page = 1, pageSize = 48 }) {
  const offset = (Math.max(1, page) - 1) * pageSize;
  let rows;
  let total;

  if (q && q.trim()) {
    const term = q.trim().replace(/[^\p{L}\p{N} _-]/gu, '') + '*';
    rows = db
      .prepare(
        `SELECT s.slug, s.title, s.cover_url, s.genres, s.years
         FROM series_fts f
         JOIN series s ON s.rowid = f.rowid
         WHERE series_fts MATCH ?
         ORDER BY rank
         LIMIT ? OFFSET ?`
      )
      .all(term, pageSize, offset);
    total = db
      .prepare(
        `SELECT COUNT(*) AS c FROM series_fts WHERE series_fts MATCH ?`
      )
      .get(term).c;
  } else if (genre && genre.trim()) {
    rows = db
      .prepare(
        `SELECT slug, title, cover_url, genres, years FROM series
         WHERE genres LIKE ?
         ORDER BY title COLLATE NOCASE
         LIMIT ? OFFSET ?`
      )
      .all(`%"${genre}"%`, pageSize, offset);
    total = db
      .prepare(`SELECT COUNT(*) AS c FROM series WHERE genres LIKE ?`)
      .get(`%"${genre}"%`).c;
  } else {
    rows = db
      .prepare(
        `SELECT slug, title, cover_url, genres, years FROM series
         ORDER BY title COLLATE NOCASE
         LIMIT ? OFFSET ?`
      )
      .all(pageSize, offset);
    total = db.prepare('SELECT COUNT(*) AS c FROM series').get().c;
  }

  return {
    items: rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      coverUrl: r.cover_url,
      genres: r.genres ? JSON.parse(r.genres) : [],
      years: r.years,
    })),
    total,
    page,
    pageSize,
  };
}

function listGenres(limit = 40) {
  const rows = db.prepare('SELECT genres FROM series WHERE genres != \'\'').all();
  const counts = new Map();
  for (const row of rows) {
    try {
      const list = JSON.parse(row.genres);
      for (const g of list) {
        counts.set(g, (counts.get(g) || 0) + 1);
      }
    } catch (e) {}
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([genre, count]) => ({ genre, count }));
}

// --- Season / Episode Helpers ---
function isSeasonStale(slug, season) {
  const row = db
    .prepare('SELECT updated_at FROM seasons WHERE slug = ? AND season = ?')
    .get(slug, season);
  if (!row) return true;
  return now() - row.updated_at > TTL.SEASON;
}

function getSeasons(slug) {
  return db
    .prepare('SELECT season FROM seasons WHERE slug = ? ORDER BY season ASC')
    .all(slug)
    .map((r) => r.season);
}

/**
 * Registriert bekannte Staffelnummern einer Serie (ohne deren Episoden zu
 * überschreiben) - lässt bereits gescrapte Staffeln unangetastet, damit sie
 * ihre eigene TTL behalten.
 */
function registerSeasons(slug, seasons) {
  const tx = db.transaction((list) => {
    for (const s of list) {
      db.prepare(
        `INSERT INTO seasons (slug, season, updated_at) VALUES (?, ?, 0)
         ON CONFLICT(slug, season) DO NOTHING`
      ).run(slug, s);
    }
  });
  tx(seasons);
}

const upsertEpisodeStmt = db.prepare(`
  INSERT INTO episodes (slug, season, number, title, bs_url, voe_url, thumbnail, summary)
  VALUES (@slug, @season, @number, @title, @bs_url, @voe_url, @thumbnail, @summary)
  ON CONFLICT(slug, season, number) DO UPDATE SET
    title = excluded.title,
    bs_url = excluded.bs_url,
    voe_url = excluded.voe_url,
    thumbnail = COALESCE(NULLIF(excluded.thumbnail, ''), episodes.thumbnail),
    summary = COALESCE(NULLIF(excluded.summary, ''), episodes.summary)
`);

function saveSeasonEpisodes(slug, season, episodes) {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO seasons (slug, season, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(slug, season) DO UPDATE SET updated_at = excluded.updated_at`
    ).run(slug, season, now());

    for (const ep of episodes) {
      upsertEpisodeStmt.run({
        slug,
        season,
        number: ep.number,
        title: ep.title || `Folge ${ep.number}`,
        bs_url: ep.bsUrl || '',
        voe_url: ep.voeUrl || '',
        thumbnail: ep.thumbnail || '',
        summary: ep.summary || '',
      });
    }
  });
  tx();
}

function getSeasonEpisodes(slug, season) {
  return db
    .prepare(
      'SELECT number, title, bs_url, voe_url, thumbnail, summary FROM episodes WHERE slug = ? AND season = ? ORDER BY number ASC'
    )
    .all(slug, season)
    .map((r) => ({
      number: r.number,
      title: r.title,
      bsUrl: r.bs_url,
      voeUrl: r.voe_url,
      thumbnail: r.thumbnail,
      summary: r.summary,
      season,
    }));
}

function getEpisode(slug, season, number) {
  const r = db
    .prepare(
      'SELECT number, title, bs_url, voe_url, thumbnail, summary FROM episodes WHERE slug = ? AND season = ? AND number = ?'
    )
    .get(slug, season, number);
  if (!r) return null;
  return {
    number: r.number,
    title: r.title,
    bsUrl: r.bs_url,
    voeUrl: r.voe_url,
    thumbnail: r.thumbnail,
    summary: r.summary,
    season,
  };
}

// --- Stream Cache Helpers ---
function getCachedStream(cacheKey) {
  const row = db.prepare('SELECT m3u8, created_at FROM streams WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  if (now() - row.created_at > TTL.STREAM) return null;
  return row.m3u8;
}

function setCachedStream(cacheKey, m3u8) {
  db.prepare(
    `INSERT INTO streams (cache_key, m3u8, created_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET m3u8 = excluded.m3u8, created_at = excluded.created_at`
  ).run(cacheKey, m3u8, now());
}

// --- Sessions ---
function createSession(id, user, expiresAt) {
  db.prepare(
    `INSERT INTO sessions (id, sub, name, email, groups, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, user.sub, user.name || null, user.email || null, JSON.stringify(user.groups || []), expiresAt);
}

function getSession(id) {
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!r) return null;
  if (r.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  return { sub: r.sub, name: r.name, email: r.email, groups: JSON.parse(r.groups || '[]') };
}

function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function purgeSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

// --- Watch Progress (pro Nutzer, eine Zeile pro Serie) ---
function saveProgress(userId, slug, season, episode, position, duration) {
  db.prepare(
    `INSERT INTO watch_progress (user_id, slug, season, episode, position, duration, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, slug) DO UPDATE SET season = excluded.season, episode = excluded.episode,
       position = excluded.position, duration = excluded.duration, updated_at = excluded.updated_at`
  ).run(userId, slug, season, episode, position, duration, now());
}

function listProgress(userId, limit = 20) {
  return db
    .prepare(
      `SELECT p.slug, p.season, p.episode, p.position, p.duration, p.updated_at, s.title, s.cover_url
       FROM watch_progress p LEFT JOIN series s ON s.slug = p.slug
       WHERE p.user_id = ? ORDER BY p.updated_at DESC LIMIT ?`
    )
    .all(userId, limit)
    .map((r) => ({
      slug: r.slug,
      title: r.title || r.slug,
      coverUrl: r.cover_url,
      season: r.season,
      episode: r.episode,
      position: r.position,
      duration: r.duration,
      updatedAt: r.updated_at,
    }));
}

function deleteProgress(userId, slug) {
  db.prepare('DELETE FROM watch_progress WHERE user_id = ? AND slug = ?').run(userId, slug);
}

// --- Startseite ---
function rowToCard(r) {
  return {
    slug: r.slug,
    title: r.title,
    coverUrl: r.cover_url,
    description: r.description,
    genres: r.genres ? JSON.parse(r.genres) : [],
    years: r.years,
  };
}

function randomHero() {
  const r = db
    .prepare(
      `SELECT slug, title, cover_url, description, genres, years FROM series
       WHERE cover_url IS NOT NULL AND cover_url != '' AND length(description) > 40
       ORDER BY RANDOM() LIMIT 1`
    )
    .get();
  return r ? rowToCard(r) : null;
}

function newestSeries(limit = 20) {
  return db
    .prepare(
      `SELECT slug, title, cover_url, description, genres, years FROM series
       WHERE cover_url IS NOT NULL AND cover_url != '' ORDER BY rowid DESC LIMIT ?`
    )
    .all(limit)
    .map(rowToCard);
}

function seriesByGenre(genre, limit = 20) {
  return db
    .prepare(
      `SELECT slug, title, cover_url, description, genres, years FROM series
       WHERE genres LIKE ? AND cover_url IS NOT NULL AND cover_url != ''
       ORDER BY RANDOM() LIMIT ?`
    )
    .all(`%"${genre}"%`, limit)
    .map(rowToCard);
}

module.exports = {
  createSession,
  getSession,
  deleteSession,
  purgeSessions,
  saveProgress,
  listProgress,
  deleteProgress,
  randomHero,
  newestSeries,
  seriesByGenre,
  db,
  TTL,
  getMeta,
  setMeta,
  upsertSeries,
  upsertSeriesBulk,
  insertNewSeries,
  getSeries,
  isSeriesStale,
  isCatalogStale,
  markCatalogSynced,
  searchCatalog,
  listGenres,
  isSeasonStale,
  getSeasons,
  registerSeasons,
  saveSeasonEpisodes,
  getSeasonEpisodes,
  getEpisode,
  getCachedStream,
  setCachedStream,
};
