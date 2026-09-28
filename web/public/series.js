/**
 * BS Web - Serien-Detailseite
 * Zeigt Beschreibung/Genres/Cast, Staffel-Tabs und Episodenliste mit Thumbnails.
 * Klick auf eine Episode navigiert zum Player (/watch?slug=...&season=...&episode=...).
 */

(function () {
  const heroEl = document.getElementById('series-hero');
  const seasonTabsEl = document.getElementById('season-tabs');
  const episodesListEl = document.getElementById('episodes-list');
  const searchInput = document.getElementById('search-input');

  const slug = decodeURIComponent(window.location.pathname.replace(/^\/serie\//, ''));
  let activeSeason = 1;
  let seriesData = null;

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderHero(series) {
    const coverHtml = series.coverUrl
      ? `<img src="${escapeHtml(series.coverUrl)}" alt="${escapeHtml(series.title)}" onerror="this.style.display='none';">`
      : '';

    const genresHtml = (series.genres || [])
      .map((g) => `<span class="chip">${escapeHtml(g)}</span>`)
      .join('');

    const castHtml = (series.cast || []).length
      ? `<div class="cast">Cast: ${escapeHtml(series.cast.join(', '))}</div>`
      : '';

    heroEl.innerHTML = `
      <div class="cover">${coverHtml}</div>
      <div class="info">
        <h1>${escapeHtml(series.title)}</h1>
        <div class="years">${escapeHtml(series.years || '')}</div>
        <div class="genres">${genresHtml}</div>
        <p class="description">${escapeHtml(series.description || 'Keine Beschreibung verfügbar.')}</p>
        ${castHtml}
      </div>
    `;
  }

  function renderSeasonTabs(seasons) {
    seasonTabsEl.innerHTML = '';
    seasons.forEach((s) => {
      const chip = document.createElement('span');
      chip.className = `chip ${s === activeSeason ? 'active' : ''}`;
      chip.textContent = `Staffel ${s}`;
      chip.addEventListener('click', () => {
        activeSeason = s;
        seasonTabsEl.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        loadSeason(s);
      });
      seasonTabsEl.appendChild(chip);
    });
  }

  function renderEpisodes(episodes) {
    episodesListEl.innerHTML = '';
    if (!episodes.length) {
      episodesListEl.innerHTML = '<div class="state-message">Keine Folgen für diese Staffel gefunden.</div>';
      return;
    }

    episodes.forEach((ep) => {
      const row = document.createElement('div');
      row.className = 'episode-row';
      row.addEventListener('click', () => {
        const params = new URLSearchParams({
          slug,
          season: ep.season,
          episode: ep.number,
          title: seriesData ? seriesData.title : slug,
        });
        window.location.href = `/watch?${params.toString()}`;
      });

      const thumbHtml = ep.thumbnail
        ? `<img src="${escapeHtml(ep.thumbnail)}" alt="S${ep.season}E${ep.number}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
           <div class="placeholder" style="display:none;">▶</div>`
        : `<div class="placeholder">▶</div>`;

      row.innerHTML = `
        <div class="episode-thumb">${thumbHtml}</div>
        <div class="episode-info">
          <span class="episode-number">Staffel ${ep.season} • Folge ${ep.number}</span>
          <span class="episode-title">${escapeHtml(ep.title)}</span>
          ${ep.summary ? `<span class="episode-summary">${escapeHtml(ep.summary)}</span>` : ''}
        </div>
      `;
      episodesListEl.appendChild(row);
    });
  }

  async function loadSeason(season) {
    episodesListEl.innerHTML = '<div class="state-message"><span class="spinner"></span>Folgen werden geladen...</div>';
    try {
      const resp = await fetch(`/api/series/${encodeURIComponent(slug)}/season/${season}`);
      const episodes = await resp.json();
      renderEpisodes(episodes);
    } catch (err) {
      episodesListEl.innerHTML = `<div class="state-message">Fehler: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function init() {
    try {
      const resp = await fetch(`/api/series/${encodeURIComponent(slug)}`);
      if (!resp.ok) throw new Error('Serie nicht gefunden');
      seriesData = await resp.json();

      document.title = `${seriesData.title} - BS Web`;
      renderHero(seriesData);

      const seasons = seriesData.seasons && seriesData.seasons.length ? seriesData.seasons : [1];
      activeSeason = seasons[0];
      renderSeasonTabs(seasons);
      loadSeason(activeSeason);
    } catch (err) {
      heroEl.innerHTML = `<div class="state-message">Fehler beim Laden der Serie: ${escapeHtml(err.message)}</div>`;
    }
  }

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      window.location.href = `/?q=${encodeURIComponent(e.target.value.trim())}`;
    }
  });

  init();
})();
