/**
 * N2nd - Player Frontend
 * Portiert aus player/player.js: hls.js Wiedergabe, Auto-Next mit Countdown,
 * Episoden-Drawer mit Thumbnails, Tastatur-Shortcuts. Chrome-Extension-APIs
 * wurden durch fetch()-Aufrufe gegen die eigene REST-API ersetzt.
 */

(function () {
  const video = document.getElementById('video-element');
  const container = document.getElementById('player-container');
  const seriesTitleEl = document.getElementById('series-title');
  const episodeSubtitleEl = document.getElementById('episode-subtitle');
  const preloadBadge = document.getElementById('preload-badge');
  const preloadBadgeText = document.getElementById('preload-badge-text');

  const btnPlayPause = document.getElementById('btn-play-pause');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');

  const btnMute = document.getElementById('btn-mute');
  const iconVolumeHigh = document.getElementById('icon-volume-high');
  const iconVolumeMuted = document.getElementById('icon-volume-muted');
  const volumeSlider = document.getElementById('volume-slider');

  const currentTimeEl = document.getElementById('current-time');
  const totalDurationEl = document.getElementById('total-duration');

  const progressWrapper = document.getElementById('progress-wrapper');
  const progressPlayed = document.getElementById('progress-played');
  const progressBuffer = document.getElementById('progress-buffer');
  const progressHandle = document.getElementById('progress-handle');

  const playbackSpeed = document.getElementById('playback-speed');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const iconFsEnter = document.getElementById('icon-fs-enter');
  const iconFsExit = document.getElementById('icon-fs-exit');

  const btnSkipBottom = document.getElementById('btn-skip-bottom');

  const btnEpisodesBottom = document.getElementById('btn-episodes-bottom');
  const episodesDrawer = document.getElementById('episodes-drawer');
  const btnCloseDrawer = document.getElementById('btn-close-drawer');
  const drawerSeriesTitle = document.getElementById('drawer-series-title');
  const drawerSeriesSubtitle = document.getElementById('drawer-series-subtitle');
  const drawerCover = document.getElementById('drawer-cover');
  const seasonTabsEl = document.getElementById('season-tabs');
  const episodesListEl = document.getElementById('episodes-list');

  const countdownOverlay = document.getElementById('countdown-overlay');
  const countdownSeconds = document.getElementById('countdown-seconds');
  const countdownBar = document.getElementById('countdown-bar');
  const btnCountdownNow = document.getElementById('btn-countdown-now');
  const btnCountdownCancel = document.getElementById('btn-countdown-cancel');

  let hls = null;
  let hlsProxyEnabled = false;
  fetch('/api/config').then((r) => r.json()).then((c) => { hlsProxyEnabled = !!c.hlsProxy; }).catch(() => {});
  let currentParams = {};
  let countdownTimer = null;
  let idleTimeout = null;
  let drawerActiveSeason = 1;
  let seriesCache = null;

  function parseQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const sParsed = parseInt(params.get('season'), 10);
    const eParsed = parseInt(params.get('episode'), 10);
    return {
      slug: params.get('slug') || '',
      title: params.get('title') || 'Serie',
      season: !isNaN(sParsed) && sParsed > 0 ? sParsed : 1,
      episode: !isNaN(eParsed) && eParsed > 0 ? eParsed : 1,
    };
  }

  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => (n < 10 ? '0' + n : n);
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  function getAutoPlaySetting() {
    return localStorage.getItem('bsweb_autoplay_next') !== 'false';
  }

  function syncUrl(slug, title, season, episode) {
    try {
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('slug', slug);
      newUrl.searchParams.set('title', title);
      newUrl.searchParams.set('season', season);
      newUrl.searchParams.set('episode', episode);
      window.history.replaceState({}, '', newUrl.toString());
    } catch (e) {}
  }

  /**
   * Lädt einen HLS-Stream. Versucht zuerst die DIREKTE CDN-URL (kein Traffic
   * über unseren Server, spart Bandbreite) und fällt bei einem fatalen
   * Netzwerkfehler automatisch auf die geproxte URL zurück (/api/hls), falls
   * der CDN die Anfrage z.B. wegen IP-Bindung der signierten URL ablehnt.
   */
  function attachHls(directUrl, proxyUrl) {
    if (!hlsProxyEnabled) proxyUrl = null;
    if (hls) {
      hls.destroy();
      hls = null;
    }

    let usingProxyFallback = !directUrl;
    if (!directUrl && !proxyUrl) { alert('Kein Stream verfügbar.'); return; }
    const initialUrl = directUrl || proxyUrl;

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 90 });
      hls.loadSource(initialUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((err) => console.warn('[Player] Autoplay benötigt Interaktion:', err));
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          // Direkter CDN-Zugriff fehlgeschlagen (z.B. IP-Bindung der signierten
          // URL) -> einmalig auf den Server-Proxy zurückfallen.
          if (!usingProxyFallback && proxyUrl && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            console.warn('[Player] Direkter Stream-Zugriff fehlgeschlagen, wechsle auf Server-Proxy...');
            usingProxyFallback = true;
            hls.destroy();
            hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 90 });
            hls.loadSource(proxyUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              video.play().catch((err) => console.warn('[Player] Autoplay benötigt Interaktion:', err));
            });
            hls.on(Hls.Events.ERROR, (event2, data2) => {
              if (data2.fatal) {
                switch (data2.type) {
                  case Hls.ErrorTypes.NETWORK_ERROR:
                    hls.startLoad();
                    break;
                  case Hls.ErrorTypes.MEDIA_ERROR:
                    hls.recoverMediaError();
                    break;
                  default:
                    hls.destroy();
                    break;
                }
              }
            });
            return;
          }

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = initialUrl;
      video.play().catch(() => {});
    } else {
      alert('Ihr Browser unterstützt keine HLS (M3U8) Wiedergabe.');
    }
  }

  function updatePreloadBadge(status, text) {
    if (status === 'ready') {
      preloadBadge.className = 'badge badge-ready';
      preloadBadgeText.textContent = text || 'Nächste Folge bereit!';
    } else if (status === 'none') {
      preloadBadge.className = 'badge';
      preloadBadgeText.textContent = text || 'Letzte Folge';
    } else if (status === 'error') {
      preloadBadge.className = 'badge';
      preloadBadgeText.textContent = text || 'Fehler';
    } else {
      preloadBadge.className = 'badge badge-loading';
      preloadBadgeText.textContent = text || 'Wird geladen...';
    }
  }

  const { extCache, resolveViaExtension, resolveStream, showLoading, hideLoading, setLoadingStatus } = window.BSResolver;

  /**
   * Löst eine Episode über die eigene API auf (CapSolver -> embed.php -> VOE -> M3U8)
   * und startet die Wiedergabe. Aktualisiert nextEpisode-Zustand.
   */
  let resolveToken = 0;
  async function resolveAndPlay(slug, season, episode, title) {
    clearTimeout(preloadPollTimer);
    const myToken = ++resolveToken;
    cancelCountdown();
    video.pause();
    if (hls) {
      hls.stopLoad();
    }
    currentParams = { slug, season, episode, title: title || currentParams.title || slug };
    drawerActiveSeason = season;

    seriesTitleEl.textContent = currentParams.title;
    episodeSubtitleEl.textContent = `Staffel ${season} • Folge ${episode}`;
    document.title = `${currentParams.title} S${season}E${episode} - N2nd`;
    syncUrl(slug, currentParams.title, season, episode);
    document.getElementById('btn-back').href = `/serie/${encodeURIComponent(slug)}`;

    updatePreloadBadge('loading', 'Stream wird aufgelöst (Captcha + Extraktion)...');
    showLoading('Video wird geladen...');

    try {
      const data = await resolveStream(slug, season, episode, setLoadingStatus);
      if (myToken !== resolveToken) return; // inzwischen andere Folge gewählt
      setLoadingStatus('Stream wird gestartet...');
      video.addEventListener('playing', hideLoading, { once: true });

      if (data.episode && data.episode.title) {
        currentParams.title = currentParams.title;
        episodeSubtitleEl.textContent = `Staffel ${season} • Folge ${episode} — ${data.episode.title}`;
      }

      currentParams.nextEpisode = data.nextEpisode || null;
      attachHls(data.directM3u8, data.m3u8);

      if (currentParams.nextEpisode) {
        updatePreloadBadge(
          'loading',
          `S${currentParams.nextEpisode.season}E${currentParams.nextEpisode.number} wird vorgeladen...`
        );
        preloadNext();
      } else {
        updatePreloadBadge('none', 'Letzte Folge');
      }
    } catch (err) {
      console.error('[Player] Resolve-Fehler:', err);
      hideLoading();
      updatePreloadBadge('error', 'Fehler: ' + err.message);
      seriesTitleEl.textContent = currentParams.title + ' — Fehler';
    }
  }

  /**
   * Löst die nächste Folge serverseitig im Hintergrund auf (Cache befüllen),
   * OHNE einen Browser-Tab zu öffnen (Invariante 3.1: nur reines fetch()).
   * Der eigentliche Vorgang (CapSolver + VOE-Extraktion) dauert 10-40s, daher
   * wird der Fortschritt über /api/preload/status gepollt, statt die Antwort
   * des fire-and-forget POST /api/preload fälschlich als "fertig" zu werten.
   */
  let preloadPollTimer = null;

  function preloadNext() {
    const next = currentParams.nextEpisode;
    if (!next) return;

    clearTimeout(preloadPollTimer);
    const slug = currentParams.slug;
    const season = next.season;
    const episode = next.number;

    if (window.BSResolver.isExtReady()) {
      const key = `${slug}_${season}_${episode}`;
      const p = resolveViaExtension(slug, season, episode);
      extCache.set(key, p);
      p.then(() => {
        if (currentParams.nextEpisode && currentParams.nextEpisode.number === episode && currentParams.nextEpisode.season === season) {
          updatePreloadBadge('ready', `Nächste Folge bereit: S${season}E${episode}`);
        }
      }).catch((err) => {
        extCache.delete(key);
        updatePreloadBadge('error', `Vorladen fehlgeschlagen: ${err.message}`);
      });
      return;
    }

    fetch('/api/preload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, season, episode }),
    }).catch(() => {});

    const poll = () => {
      // Falls der Nutzer inzwischen weitergesprungen ist, nicht mehr aktualisieren.
      if (!currentParams.nextEpisode || currentParams.nextEpisode.number !== episode || currentParams.nextEpisode.season !== season) {
        return;
      }

      fetch(`/api/preload/status?slug=${encodeURIComponent(slug)}&season=${season}&episode=${episode}`)
        .then((r) => r.json())
        .then((status) => {
          if (status.ready) {
            updatePreloadBadge('ready', `Nächste Folge bereit: S${season}E${episode}`);
          } else if (status.error) {
            updatePreloadBadge('error', `Vorladen fehlgeschlagen: ${status.error}`);
          } else {
            preloadPollTimer = setTimeout(poll, 3000);
          }
        })
        .catch(() => {
          preloadPollTimer = setTimeout(poll, 3000);
        });
    };

    preloadPollTimer = setTimeout(poll, 3000);
  }

  function skipToNextEpisode() {
    cancelCountdown();
    const next = currentParams.nextEpisode;
    if (!next) {
      alert('Keine weitere Folge verfügbar.');
      return;
    }
    resolveAndPlay(currentParams.slug, next.season, next.number, currentParams.title);
  }

  function playSpecificEpisode(ep) {
    closeEpisodesDrawer();
    resolveAndPlay(currentParams.slug, ep.season, ep.number, currentParams.title);
  }

  async function openEpisodesDrawer() {
    episodesDrawer.classList.remove('hidden');
    container.classList.remove('idle');
    drawerActiveSeason = currentParams.season || 1;

    const slug = currentParams.slug;
    drawerSeriesTitle.textContent = currentParams.title || 'Serie';
    drawerSeriesSubtitle.textContent = 'Wähle eine Folge zum direkten Abspielen';

    if (!slug) return;

    if (!seriesCache) {
      try {
        const resp = await fetch(`/api/series/${encodeURIComponent(slug)}`);
        seriesCache = await resp.json();
      } catch (e) {
        episodesListEl.innerHTML = '<div style="color:rgba(255,255,255,0.5); padding:20px; text-align:center;">Serie konnte nicht geladen werden.</div>';
        return;
      }
    }

    if (seriesCache.coverUrl) {
      drawerCover.src = seriesCache.coverUrl;
      drawerCover.classList.remove('hidden');
    }

    const seasons = seriesCache.seasons && seriesCache.seasons.length ? seriesCache.seasons : [1];
    seasonTabsEl.innerHTML = '';
    seasons.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = `season-tab-btn ${s === drawerActiveSeason ? 'active' : ''}`;
      btn.textContent = `Staffel ${s}`;
      btn.addEventListener('click', () => {
        drawerActiveSeason = s;
        seasonTabsEl.querySelectorAll('.season-tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        renderDrawerEpisodes(s);
      });
      seasonTabsEl.appendChild(btn);
    });

    renderDrawerEpisodes(drawerActiveSeason);
  }

  async function renderDrawerEpisodes(season) {
    episodesListEl.innerHTML = '<div style="color:rgba(255,255,255,0.5); padding:20px; text-align:center;">Lädt...</div>';
    try {
      const resp = await fetch(`/api/series/${encodeURIComponent(currentParams.slug)}/season/${season}`);
      const eps = await resp.json();

      episodesListEl.innerHTML = '';
      if (!eps.length) {
        episodesListEl.innerHTML = '<div style="color:rgba(255,255,255,0.5); padding:20px; text-align:center;">Keine Folgen für diese Staffel gefunden.</div>';
        return;
      }

      eps.forEach((ep) => {
        const isCurrent = ep.season === currentParams.season && ep.number === currentParams.episode;
        const card = document.createElement('div');
        card.className = `episode-card ${isCurrent ? 'active' : ''}`;

        const thumbHtml = ep.thumbnail
          ? `<img src="${ep.thumbnail}" class="episode-thumb" alt="S${ep.season}E${ep.number}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
             <div class="episode-thumb-placeholder" style="display:none;">▶</div>`
          : `<div class="episode-thumb-placeholder">▶</div>`;

        card.innerHTML = `
          <div class="episode-thumb-container">
            ${thumbHtml}
            ${isCurrent ? '<div class="now-playing-badge">▶ Wiedergabe</div>' : ''}
          </div>
          <div class="episode-info">
            <span class="episode-number">Staffel ${ep.season} • Folge ${ep.number}</span>
            <span class="episode-title" title="${ep.title}">${ep.title}</span>
            ${ep.summary ? `<span class="episode-summary">${ep.summary}</span>` : ''}
          </div>
        `;

        card.addEventListener('click', () => playSpecificEpisode(ep));
        episodesListEl.appendChild(card);
      });
    } catch (err) {
      episodesListEl.innerHTML = `<div style="color:rgba(255,255,255,0.5); padding:20px; text-align:center;">Fehler: ${err.message}</div>`;
    }
  }

  function closeEpisodesDrawer() {
    episodesDrawer.classList.add('hidden');
  }

  btnEpisodesBottom.addEventListener('click', openEpisodesDrawer);
  btnCloseDrawer.addEventListener('click', closeEpisodesDrawer);

  function triggerEndCountdown() {
    if (!getAutoPlaySetting() || !currentParams.nextEpisode) return;

    let remaining = 5;
    countdownSeconds.textContent = remaining;
    countdownBar.style.width = '100%';
    countdownOverlay.classList.remove('hidden');

    const interval = setInterval(() => {
      remaining--;
      countdownSeconds.textContent = remaining;
      countdownBar.style.width = `${(remaining / 5) * 100}%`;
      if (remaining <= 0) {
        clearInterval(interval);
        countdownTimer = null;
        countdownOverlay.classList.add('hidden');
        skipToNextEpisode();
      }
    }, 1000);

    countdownTimer = interval;
  }

  function cancelCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    countdownOverlay.classList.add('hidden');
  }

  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    currentTimeEl.textContent = formatTime(video.currentTime);
    totalDurationEl.textContent = formatTime(video.duration);

    const percent = (video.currentTime / video.duration) * 100;
    progressPlayed.style.width = `${percent}%`;
    progressHandle.style.left = `${percent}%`;

    if (video.buffered.length > 0) {
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      progressBuffer.style.width = `${(bufferedEnd / video.duration) * 100}%`;
    }
  });

  video.addEventListener('play', () => {
    iconPlay.classList.add('hidden');
    iconPause.classList.remove('hidden');
  });

  video.addEventListener('pause', () => {
    iconPlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
  });

  video.addEventListener('ended', () => triggerEndCountdown());

  progressWrapper.addEventListener('click', (e) => {
    const rect = progressWrapper.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    if (video.duration) video.currentTime = pos * video.duration;
  });

  function togglePlay() {
    if (video.paused || video.ended) video.play();
    else video.pause();
  }

  btnPlayPause.addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);

  volumeSlider.addEventListener('input', (e) => {
    video.volume = parseFloat(e.target.value);
    video.muted = video.volume === 0;
    updateVolumeIcon();
  });

  btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    updateVolumeIcon();
  });

  function updateVolumeIcon() {
    if (video.muted || video.volume === 0) {
      iconVolumeHigh.classList.add('hidden');
      iconVolumeMuted.classList.remove('hidden');
    } else {
      iconVolumeHigh.classList.remove('hidden');
      iconVolumeMuted.classList.add('hidden');
    }
  }

  btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) container.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      iconFsEnter.classList.add('hidden');
      iconFsExit.classList.remove('hidden');
    } else {
      iconFsEnter.classList.remove('hidden');
      iconFsExit.classList.add('hidden');
    }
  });

  playbackSpeed.addEventListener('change', (e) => {
    video.playbackRate = parseFloat(e.target.value);
  });

  btnSkipBottom.addEventListener('click', skipToNextEpisode);
  btnCountdownNow.addEventListener('click', skipToNextEpisode);
  btnCountdownCancel.addEventListener('click', cancelCountdown);

  function resetIdleTimer() {
    container.classList.remove('idle');
    clearTimeout(idleTimeout);
    if (!video.paused && episodesDrawer.classList.contains('hidden')) {
      idleTimeout = setTimeout(() => container.classList.add('idle'), 3000);
    }
  }

  document.addEventListener('mousemove', resetIdleTimer);
  document.addEventListener('mousedown', resetIdleTimer);

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    switch (e.key.toLowerCase()) {
      case ' ':
      case 'k':
        e.preventDefault();
        togglePlay();
        break;
      case 'e':
        e.preventDefault();
        if (episodesDrawer.classList.contains('hidden')) openEpisodesDrawer();
        else closeEpisodesDrawer();
        break;
      case 'escape':
        if (!episodesDrawer.classList.contains('hidden')) {
          e.preventDefault();
          closeEpisodesDrawer();
        }
        break;
      case 'n':
        e.preventDefault();
        skipToNextEpisode();
        break;
      case 'f':
        e.preventDefault();
        btnFullscreen.click();
        break;
      case 'm':
        e.preventDefault();
        btnMute.click();
        break;
      case 'arrowleft':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
        break;
      case 'arrowright':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        break;
      case 'arrowup':
        e.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
        volumeSlider.value = video.volume;
        updateVolumeIcon();
        break;
      case 'arrowdown':
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
        volumeSlider.value = video.volume;
        updateVolumeIcon();
        break;
    }
  });

  const params = parseQueryParams();
  if (params.slug) {
    resolveAndPlay(params.slug, params.season, params.episode, params.title);
  } else {
    seriesTitleEl.textContent = 'Keine Serie angegeben';
  }
})();
