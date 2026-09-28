/**
 * BS Web - Burning Series Scraper
 * Holt Katalog, Serien-Metadaten, Staffel-Episodenlisten und die Episoden-Detailseite
 * (LID / Security-Token / reCAPTCHA-Sitekey) direkt von burningseries.cx (Fallback: bs.to).
 */

const cheerio = require('cheerio');

const PRIMARY_BASE = process.env.BS_BASE_URL || 'https://burningseries.cx';
const FALLBACK_BASE = process.env.BS_FALLBACK_URL || 'https://bs.to';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function absoluteUrl(base, href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  return new URL(href.replace(/^\//, ''), base.endsWith('/') ? base : base + '/').href;
}

function ensureVoe(url) {
  if (!url) return null;
  let clean = url.trim();
  if (!clean.startsWith('http')) {
    clean = absoluteUrl(PRIMARY_BASE, clean);
  }
  if (/\/VOE$/i.test(clean)) return clean;
  if (/\/(de|en|des)$/i.test(clean)) return clean + '/VOE';
  if (/\/(de|en|des)\/[^/]+$/i.test(clean)) return clean.replace(/\/[^/]+$/, '/VOE');
  return clean.replace(/\/$/, '') + '/de/VOE';
}

/**
 * Minimaler Cookie-Jar: BS setzt DDoS-Guard-/Session-Cookies (__ddg*, __bsduid),
 * die embed.php zur Validierung des Clients erwartet. fetch() persistiert
 * Cookies NICHT automatisch zwischen Requests, daher müssen wir sie manuell
 * einsammeln und bei Folge-Requests (z.B. /ajax/embed.php) mitschicken.
 */
function extractCookies(response) {
  const jar = {};
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) {
      jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function fetchHtml(pathOrUrl) {
  const candidates = pathOrUrl.startsWith('http')
    ? [pathOrUrl]
    : [absoluteUrl(PRIMARY_BASE, pathOrUrl), absoluteUrl(FALLBACK_BASE, pathOrUrl)];

  let lastErr = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (resp.ok) {
        return { html: await resp.text(), finalUrl: resp.url || url, cookies: extractCookies(resp) };
      }
      lastErr = new Error(`HTTP ${resp.status} für ${url}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Konnte Seite nicht laden: ' + pathOrUrl);
}

/**
 * Scrapt den vollständigen Katalog von /andere-serien.
 * Struktur: <div class="genre">...<a href="serie/Slug">Titel</a>...
 */
async function fetchCatalog() {
  const { html } = await fetchHtml('/andere-serien');
  const $ = cheerio.load(html);
  const seen = new Map();

  $('a[href^="serie/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/^serie\/([^/]+)\/?$/);
    if (!m) return;
    const slug = decodeURIComponent(m[1]);
    const title = $(el).text().trim();
    if (!title) return;
    if (!seen.has(slug)) {
      seen.set(slug, { slug, title });
    }
  });

  return Array.from(seen.values());
}

/**
 * Scrapt Metadaten einer Serie (Beschreibung, Genres, Jahre, Cast, Cover).
 */
async function fetchSeries(slug) {
  const { html } = await fetchHtml(`/serie/${slug}`);
  const $ = cheerio.load(html);

  const title = $('#sp_left h2').first().clone().children('small').remove().end().text().trim() ||
    slug.replace(/[-_]/g, ' ');

  const description = $('#sp_left > p').first().text().trim();

  const genres = [];
  $('#sp_left .infos > div')
    .filter((_, el) => $(el).find('span').first().text().trim() === 'Genres')
    .find('p span')
    .each((_, el) => {
      const g = $(el).text().trim();
      if (g) genres.push(g);
    });

  let years = '';
  $('#sp_left .infos > div')
    .filter((_, el) => $(el).find('span').first().text().trim() === 'Produktionsjahre')
    .find('p')
    .each((_, el) => {
      years = $(el).text().replace(/\s+/g, ' ').trim();
    });

  const cast = [];
  $('#sp_left .infos > div')
    .filter((_, el) => $(el).find('span').first().text().trim() === 'Hauptdarsteller')
    .find('p span')
    .each((_, el) => {
      const c = $(el).text().replace(/,$/, '').trim();
      if (c && !/keine angabe/i.test(c)) cast.push(c);
    });

  let coverUrl = null;
  const coverSrc = $('#sp_right img').attr('src');
  if (coverSrc) coverUrl = absoluteUrl(PRIMARY_BASE, coverSrc);

  const seasonsSet = new Set();
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const seasonHrefRegex = new RegExp(`^serie/${escapedSlug}/(\\d+)(?:/|$)`);
  $(`a[href^="serie/${slug}/"]`).each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(seasonHrefRegex);
    if (m) seasonsSet.add(parseInt(m[1], 10));
  });
  if (seasonsSet.size === 0) seasonsSet.add(1);

  return {
    slug,
    title,
    description,
    genres,
    years,
    cast,
    coverUrl,
    seasons: Array.from(seasonsSet).sort((a, b) => a - b),
  };
}

/**
 * Scrapt eine einzelne Staffel: vollständige Episoden-Slugs + Hoster-Links.
 */
async function fetchSeason(slug, seasonNum) {
  const sInt = parseInt(seasonNum, 10) || 1;
  const { html } = await fetchHtml(`/serie/${slug}/${sInt}/de`);
  const $ = cheerio.load(html);
  const episodes = [];

  $('table.episodes tbody tr, table.episodes tr').each((_, row) => {
    const $row = $(row);
    const firstCellLink = $row.find('td').first().find('a').first();
    if (!firstCellLink.length) return;

    const href = firstCellLink.attr('href') || '';
    const num = parseInt(firstCellLink.text().trim(), 10);
    if (isNaN(num) || !href) return;

    let title = firstCellLink.attr('title') || '';
    if (!title) {
      title = $row.find('td').eq(1).text().trim();
    }

    const fullHref = absoluteUrl(PRIMARY_BASE, href);

    episodes.push({
      number: num,
      title: title || `Folge ${num}`,
      bsUrl: fullHref,
      voeUrl: ensureVoe(fullHref),
      season: sInt,
    });
  });

  episodes.sort((a, b) => a.number - b.number);
  return episodes;
}

/**
 * Holt die Episoden-Detailseite (VOE-Hoster-Tab): LID, Security-Token, reCAPTCHA-Sitekey.
 */
async function fetchEpisodePage(bsUrl) {
  const { html, finalUrl, cookies } = await fetchHtml(bsUrl);
  const $ = cheerio.load(html);

  const lid = $('.hoster-player[data-lid]').attr('data-lid') || $('[data-lid]').first().attr('data-lid') || null;
  const token = $('meta[name="security_token"]').attr('content') || '';

  let sitekey = null;
  const sitekeyMatch =
    html.match(/series\.init\s*\(\s*\d+\s*,\s*\d+\s*,\s*['"]([^'"]+)['"]\s*\)/) ||
    html.match(/data-sitekey=["']([^"']{20,})["']/) ||
    html.match(/['"](6L[A-Za-z0-9_-]{30,})['"]/);
  if (sitekeyMatch) sitekey = sitekeyMatch[1];

  return { lid, token, sitekey, pageUrl: finalUrl, html, cookies };
}

module.exports = {
  PRIMARY_BASE,
  FALLBACK_BASE,
  UA,
  ensureVoe,
  absoluteUrl,
  cookieHeader,
  fetchHtml,
  fetchCatalog,
  fetchSeries,
  fetchSeason,
  fetchEpisodePage,
};
