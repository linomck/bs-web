/**
 * N2nd - VOE Resolver
 * Lädt die VOE-Hoster-Seite (folgt ggf. einem JS-Redirect-Gate) und entschlüsselt
 * den MKGMa-verschleierten String zur finalen M3U8 Master-Playlist.
 * Algorithmus (siehe AGENTS.md Abschnitt 4): ROT13 -> Underscores entfernen ->
 * Base64 Decode -> Shift(-3) -> Reverse -> Base64 Decode -> JSON.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function rot13Decode(s) {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const code = c.charCodeAt(0) + 13;
    const limit = c <= 'Z' ? 90 : 122;
    return String.fromCharCode(code <= limit ? code : code - 26);
  });
}

function shiftCharacters(s, offset) {
  return s
    .split('')
    .map((c) => String.fromCharCode(c.charCodeAt(0) - offset))
    .join('');
}

function b64decode(s) {
  const sanitized = s.replace(/[^A-Za-z0-9+/=]/g, '');
  const padding = sanitized.length % 4;
  const padded = padding === 0 ? sanitized : sanitized + '='.repeat(4 - padding);
  return Buffer.from(padded, 'base64').toString('binary');
}

function extractMKGMaSource(html) {
  let match = html.match(/MKGMa\s*=\s*["'](.*?)["']/);
  if (!match) {
    match = html.match(/<script type="application\/json">.*?\[(.*?)\]<\/script>/s);
  }
  if (!match) return null;

  try {
    const rawMKGMa = match[1];
    const step1 = rot13Decode(rawMKGMa);
    const step2 = step1.replace(/_/g, '');
    const step3 = b64decode(step2);
    const step4 = shiftCharacters(step3, 3);
    const step5 = step4.split('').reverse().join('');
    const decoded = b64decode(step5);

    const json = JSON.parse(decoded);
    return json.source || json.direct_access_url || null;
  } catch (err) {
    console.warn('[VOE] MKGMa Fehler:', err.message);
    return null;
  }
}

/**
 * Löst eine VOE-Embed-URL zur finalen M3U8-Master-Playlist auf.
 * Folgt max. 1x einem window.location.href JS-Redirect-Gate (siehe AGENTS.md 3.4).
 */
async function resolveVoeStream(voeUrl) {
  const resp = await fetch(voeUrl, {
    headers: { 'User-Agent': UA, Referer: voeUrl },
  });
  let html = await resp.text();

  let stream = extractMKGMaSource(html);
  if (!stream) {
    const redirMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (redirMatch && redirMatch[1].startsWith('http')) {
      const redirResp = await fetch(redirMatch[1], {
        headers: { 'User-Agent': UA, Referer: voeUrl },
      });
      html = await redirResp.text();
      stream = extractMKGMaSource(html);
    }
  }

  return stream;
}

module.exports = {
  UA,
  extractMKGMaSource,
  resolveVoeStream,
};
