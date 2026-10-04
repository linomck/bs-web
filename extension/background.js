/**
 * N2nd - Service Worker
 * Läuft beim Nutzer: Episodenseite -> (Captcha-Ticket vom Server) -> embed.php
 * -> VOE -> MKGMa-Dekodierung -> M3U8. Nur das Captcha wird serverseitig gelöst,
 * alles andere geht von der IP des Nutzers aus. Aufrufer: N2nd via
 * chrome.runtime.sendMessage(EXTENSION_ID, ...) (externally_connectable).
 */

const BS_HOSTS = ['burningseries.cx', 'bs.to'];

function rot13(s) {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const code = c.charCodeAt(0) + 13;
    return String.fromCharCode(code <= (c <= 'Z' ? 90 : 122) ? code : code - 26);
  });
}

function b64decode(s) {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  return atob(padded);
}

function extractMKGMaSource(html) {
  let m = html.match(/MKGMa\s*=\s*["'](.*?)["']/);
  if (!m) m = html.match(/<script type="application\/json">.*?\[(.*?)\]<\/script>/s);
  if (!m) return null;
  try {
    const s2 = rot13(m[1]).replace(/_/g, '');
    const s4 = b64decode(s2).split('').map((c) => String.fromCharCode(c.charCodeAt(0) - 3)).join('');
    const json = JSON.parse(b64decode(s4.split('').reverse().join('')));
    return json.source || json.direct_access_url || null;
  } catch (e) {
    return null;
  }
}

async function resolveVoe(voeUrl) {
  let html = await (await fetch(voeUrl)).text();
  let src = extractMKGMaSource(html);
  if (!src) {
    const r = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (r && r[1].startsWith('http')) {
      html = await (await fetch(r[1])).text();
      src = extractMKGMaSource(html);
    }
  }
  return src;
}

function parseEpisodePage(html) {
  const lid = (html.match(/data-lid=["'](\d+)["']/) || [])[1] || null;
  const token =
    (html.match(/<meta[^>]*name=["']security_token["'][^>]*content=["']([^"']*)["']/) ||
      html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']security_token["']/) ||
      [])[1] || '';
  const sk =
    html.match(/series\.init\s*\(\s*\d+\s*,\s*\d+\s*,\s*['"]([^'"]+)['"]\s*\)/) ||
    html.match(/data-sitekey=["']([^"']{20,})["']/) ||
    html.match(/['"](6L[A-Za-z0-9_-]{30,})['"]/);
  return { lid, token, sitekey: sk ? sk[1] : null };
}

async function fetchTicket(apiBase, pageUrl, sitekey) {
  const r = await fetch(apiBase + '/api/captcha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageUrl, sitekey }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ticket) throw new Error(d.error || `Captcha-API HTTP ${r.status}`);
  return d.ticket;
}

async function resolveEpisode(episodeUrl, apiBase) {
  const u = new URL(episodeUrl);
  if (!BS_HOSTS.includes(u.hostname)) throw new Error('Ungültiger Host');

  // credentials:'include' -> Browser-Cookie-Jar (DDoS-Guard-Cookies) wird genutzt
  const pageResp = await fetch(episodeUrl, { credentials: 'include' });
  if (!pageResp.ok) throw new Error(`Episodenseite HTTP ${pageResp.status}`);
  const pageUrl = pageResp.url;
  const { lid, token, sitekey } = parseEpisodePage(await pageResp.text());
  if (!lid) throw new Error('data-lid nicht gefunden');
  if (!sitekey) throw new Error('reCAPTCHA-Sitekey nicht gefunden');

  const ticket = await fetchTicket(apiBase, pageUrl, sitekey);

  const embed = await fetch(new URL('/ajax/embed.php', pageUrl).href, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    referrer: pageUrl,
    body: new URLSearchParams({ LID: lid, ticket, token }).toString(),
  });
  const text = await embed.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error(`embed.php HTTP ${embed.status}: ${text.slice(0, 120)}`);
  }
  if (!data.link) throw new Error('Kein VOE-Link: ' + JSON.stringify(data));

  const m3u8 = await resolveVoe(data.link);
  if (!m3u8) throw new Error('M3U8 nicht extrahierbar');
  return m3u8;
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.origin) return;
  if (msg.type === 'ping') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return;
  }
  if (msg.type === 'resolve') {
    resolveEpisode(msg.episodeUrl, sender.origin)
      .then((m3u8) => sendResponse({ ok: true, m3u8 }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
