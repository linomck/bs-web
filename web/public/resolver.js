/* Gemeinsamer Stream-Resolver (Extension zuerst, Server als Fallback) + Loading-Screen. */
(function () {
  let extId = null;
  let extReady = false;
  let extError = '';
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

  function extResolve(episodeUrl, token, onStatus) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let port;
      try {
        port = chrome.runtime.connect(extId);
      } catch (e) {
        return reject(e);
      }
      port.onMessage.addListener((m) => {
        if (m.ping) return;
        if (m.step) {
          if (onStatus) onStatus(m.step);
        } else if (m.done) {
          finished = true;
          try { port.disconnect(); } catch (e) { /* ignorieren */ }
          resolve(m.m3u8);
        } else {
          finished = true;
          try { port.disconnect(); } catch (e) { /* ignorieren */ }
          reject(new Error(m.error || 'Extension-Fehler'));
        }
      });
      port.onDisconnect.addListener(() => {
        if (!finished) reject(new Error('Verbindung zur Extension abgebrochen'));
      });
      const leave = () => { try { port.disconnect(); } catch (e) { /* ignorieren */ } };
      window.addEventListener('pagehide', leave, { once: true });
      port.postMessage({ type: 'resolve', episodeUrl, token });
    });
  }

  const extInit = (async () => {
    try {
      if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        extError = 'Browser/Seite hat keinen Zugriff auf Extensions';
        return;
      }
      extId = (await (await fetch('/api/config')).json()).extensionId;
      const pong = await extSend({ type: 'ping' });
      extReady = !!(pong && pong.ok);
      if (!extReady) extError = 'Extension antwortet nicht';
    } catch (e) {
      extReady = false;
      extError = e.message;
    }
  })();

  function proxyUrlFor(url) {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(url)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return '/api/hls?u=' + encodeURIComponent(b64);
  }

  async function resolveViaExtension(slug, season, episode, onStatus) {
    const say = onStatus || (() => {});
    say('Episodeninfo wird vom Server geladen...');
    const infoResp = await fetch(
      `/api/episode-info?slug=${encodeURIComponent(slug)}&season=${season}&episode=${episode}`
    );
    const info = await infoResp.json();
    if (!infoResp.ok) throw new Error(info.error || `HTTP ${infoResp.status}`);
    say('Anfrage wird an Extension gesendet...');
    const m3u8 = await extResolve(info.episodeUrl, info.captchaToken, say).catch((e) => {
      if (!/abgebrochen/.test(e.message)) throw e;
      say('Verbindung abgebrochen – neuer Versuch...');
      return extResolve(info.episodeUrl, info.captchaToken, say);
    });
    return { directM3u8: m3u8, m3u8: proxyUrlFor(m3u8), episode: info.episode, nextEpisode: info.nextEpisode };
  }

  function takeStash(key) {
    try {
      const s = JSON.parse(sessionStorage.getItem(STASH_KEY) || 'null');
      sessionStorage.removeItem(STASH_KEY);
      if (s && s.key === key && Date.now() - s.ts < 10 * 60 * 1000) return s.data;
    } catch (e) { /* ignorieren */ }
    return null;
  }

  async function resolveStream(slug, season, episode, onStatus) {
    const key = `${slug}_${season}_${episode}`;
    const stashed = takeStash(key);
    if (stashed) return stashed;

    await extInit;
    if (!extReady) {
      throw new Error('N2nd-Extension nicht erreichbar: ' + (extError || 'unbekannt') + '. Bitte Extension installieren/neu laden.');
    }
    let p = extCache.get(key);
    if (!p) {
      p = resolveViaExtension(slug, season, episode, onStatus);
      extCache.set(key, p);
      p.catch(() => extCache.delete(key));
    }
    return p;
  }

  /** Löst auf und merkt das Ergebnis für die Player-Seite vor. */
  async function resolveAndStash(slug, season, episode, onStatus) {
    const data = await resolveStream(slug, season, episode, onStatus);
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
  function setLoadingStatus(text) {
    if (overlay) overlay.querySelector('.loading-sub').textContent = text;
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
    setLoadingStatus,
    isExtReady: () => extReady,
  };
})();
