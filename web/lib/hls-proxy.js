/**
 * BS Web - HLS Proxy
 * Reicht Playlists und Segmente von VOE-CDNs durch, damit der Browser sie ohne
 * CORS-/Referer-Probleme laden kann. Playlists werden zeilenweise umgeschrieben,
 * sodass jede referenzierte URI erneut über /api/hls läuft.
 */

const VOE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function encodeProxyUrl(absoluteUrl) {
  return '/api/hls?u=' + encodeURIComponent(Buffer.from(absoluteUrl, 'utf8').toString('base64url'));
}

function decodeProxyParam(param) {
  return Buffer.from(param, 'base64url').toString('utf8');
}

function isPlaylist(url, contentType) {
  if (contentType && /mpegurl|vnd\.apple\.mpegurl/i.test(contentType)) return true;
  return /\.m3u8(\?|$)/i.test(url);
}

/**
 * Schreibt eine M3U8-Playlist so um, dass alle referenzierten URIs (Segmente,
 * Sub-Playlists, Keys) wieder über den eigenen Proxy laufen.
 */
function rewritePlaylist(playlistText, baseUrl) {
  const lines = playlistText.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // URI="..." Attribute in Tags wie #EXT-X-KEY oder #EXT-X-MAP
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        const abs = new URL(uri, baseUrl).href;
        return `URI="${encodeProxyUrl(abs)}"`;
      });
    }

    // Reguläre Zeile = URI zu Segment oder Sub-Playlist
    const abs = new URL(trimmed, baseUrl).href;
    return encodeProxyUrl(abs);
  });

  return rewritten.join('\n');
}

/**
 * Express-Handler für GET /api/hls?u=<base64url-URL>
 * Streamt Playlists (umgeschrieben) oder Segmente/Keys (binär, mit Range-Support) durch.
 */
async function handleHlsProxy(req, res) {
  const param = req.query.u;
  if (!param) {
    res.status(400).json({ error: 'Fehlender Parameter u' });
    return;
  }

  let targetUrl;
  try {
    targetUrl = decodeProxyParam(param);
    if (!/^https?:\/\//i.test(targetUrl)) throw new Error('invalid url');
  } catch (err) {
    res.status(400).json({ error: 'Ungültiger Proxy-Parameter' });
    return;
  }

  try {
    const upstreamHeaders = {
      'User-Agent': VOE_UA,
      Referer: targetUrl,
    };
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
    }

    const upstream = await fetch(targetUrl, { headers: upstreamHeaders });

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).json({ error: `Upstream HTTP ${upstream.status}` });
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';

    if (isPlaylist(targetUrl, contentType)) {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, targetUrl);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.send(rewritten);
      return;
    }

    // Binär durchreichen (Segmente, Keys) inkl. Range-Support
    res.status(upstream.status);
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const cr = upstream.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    const ar = upstream.headers.get('accept-ranges');
    if (ar) res.setHeader('Accept-Ranges', ar);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error('[HLS-Proxy] Fehler:', err.message);
    res.status(502).json({ error: 'Proxy-Fehler: ' + err.message });
  }
}

module.exports = { encodeProxyUrl, decodeProxyParam, rewritePlaylist, handleHlsProxy };
