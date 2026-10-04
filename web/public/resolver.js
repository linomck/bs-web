/* Gemeinsamer Stream-Resolver (Extension zuerst, Server als Fallback) + Loading-Screen. */
(function () {
  let extId = null;
  let extReady = false;
  const extCache = new Map(); // "slug_s_e" -> Promise<data>
  const STASH_KEY = 'bs_prefetch';

  function extSend(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(extId, msg, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  const extInit = (async () => {
    try {
      if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) return;
      extId = (await (await fetch('/api/config')).json()).extensionId;
      const pong = await extSend({ type: 'ping' });
      extReady = !!(pong && pong.ok);
    } catch (e) {
      extReady = false;
    }
  })();

  function proxyUrlFor(url) {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(url)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return '/api/hls?u=' + encodeURIComponent(b64);
  }

  async function resolveViaExtension(slug, season, episode) {
    const infoResp = await fetch(
      `/api/episode-info?slug=${encodeURIComponent(slug)}&season=${season}&episode=${episode}`
    );
    const info = await infoResp.json();
    if (!infoResp.ok) throw new Error(info.error || `HTTP ${infoResp.status}`);
    const r = await extSend({ type: 'resolve', episodeUrl: info.episodeUrl });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Extension-Fehler');
    return { directM3u8: r.m3u8, m3u8: proxyUrlFor(r.m3u8), episode: info.episode, nextEpisode: info.nextEpisode };
  }

  async function resolveViaServer(slug, season, episode) {
    const resp = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, season, episode }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  function takeStash(key) {
    try {
      const s = JSON.parse(sessionStorage.getItem(STASH_KEY) || 'null');
      sessionStorage.removeItem(STASH_KEY);
      if (s && s.key === key && Date.now() - s.ts < 10 * 60 * 1000) return s.data;
    } catch (e) { /* ignorieren */ }
    return null;
  }

  async function resolveStream(slug, season, episode) {
    const key = `${slug}_${season}_${episode}`;
    const stashed = takeStash(key);
    if (stashed) return stashed;

    await extInit;
    if (extReady) {
      let p = extCache.get(key);
      if (!p) {
        p = resolveViaExtension(slug, season, episode);
        extCache.set(key, p);
        p.catch(() => extCache.delete(key));
      }
      try {
        return await p;
      } catch (err) {
        console.warn('[Resolver] Extension-Resolve fehlgeschlagen, Server-Fallback:', err.message);
        extCache.delete(key);
      }
    }
    return resolveViaServer(slug, season, episode);
  }

  /** Löst auf und merkt das Ergebnis für die Player-Seite vor. */
  async function resolveAndStash(slug, season, episode) {
    const data = await resolveStream(slug, season, episode);
    sessionStorage.setItem(
      STASH_KEY,
      JSON.stringify({ key: `${slug}_${season}_${episode}`, ts: Date.now(), data })
    );
    return data;
  }

  // --- Loading-Screen ---
  let overlay = null;
  function showLoading(text, sub) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'loading-screen';
      overlay.innerHTML =
        '<div class="loading-ring"></div><div class="loading-text"></div><div class="loading-sub"></div>';
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.loading-text').textContent = text || 'Video wird geladen...';
    overlay.querySelector('.loading-sub').textContent = sub || '';
    overlay.classList.remove('hidden');
  }
  function hideLoading() {
    if (overlay) overlay.classList.add('hidden');
  }

  window.BSResolver = {
    extCache,
    resolveViaExtension,
    resolveStream,
    resolveAndStash,
    showLoading,
    hideLoading,
    isExtReady: () => extReady,
  };
})();
