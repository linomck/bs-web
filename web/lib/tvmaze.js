/**
 * BS Web - TVmaze Metadaten
 * Kostenlose Anreicherung mit Serien-Cover und Episoden-Thumbnails/Beschreibungen
 * (siehe AGENTS.md Abschnitt 5).
 */

function buildQueryCandidates(rawTitle) {
  // Burning Series listet oft mehrere Titel getrennt durch " | ", z.B.
  // "Game of Thrones | GoT" oder "Die Simpsons | The Simpsons". TVmaze's
  // singlesearch findet damit NICHTS - wir probieren daher jeden Titel
  // einzeln, sauber bereinigt (Jahr in Klammern entfernt, Slug-Bindestriche
  // durch Leerzeichen ersetzt).
  const parts = rawTitle
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);

  const candidates = parts.length ? parts : [rawTitle];

  return candidates
    .map((p) =>
      p
        .replace(/-OP$/i, '')
        .replace(/-GoT$/i, '')
        .replace(/[-_]/g, ' ')
        .replace(/\(\d{4}\)\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
}

async function trySingleSearch(query) {
  const resp = await fetch(
    `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}&embed=episodes`
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  return data && data.id ? data : null;
}

async function fetchTvmazeMetadata(queryTitle) {
  if (!queryTitle) return null;

  const candidates = buildQueryCandidates(queryTitle);

  try {
    let data = null;
    for (const candidate of candidates) {
      data = await trySingleSearch(candidate);
      if (data) break;
    }
    if (!data) return null;

    const coverUrl = (data.image && (data.image.medium || data.image.original)) || null;
    const episodeMap = {};

    if (data._embedded && Array.isArray(data._embedded.episodes)) {
      for (const ep of data._embedded.episodes) {
        const key = `${ep.season}_${ep.number}`;
        episodeMap[key] = {
          thumbnail: (ep.image && (ep.image.medium || ep.image.original)) || null,
          nameEn: ep.name || null,
          summary: ep.summary ? ep.summary.replace(/<[^>]*>/g, '').trim() : null,
        };
      }
    }

    return { coverUrl, showTitle: data.name, episodes: episodeMap };
  } catch (err) {
    console.warn('[TVmaze] API nicht erreichbar:', err.message);
    return null;
  }
}

module.exports = { fetchTvmazeMetadata };
