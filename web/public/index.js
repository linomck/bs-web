/**
 * BS Web - Katalog Frontend
 * Live-Suche (debounced), Genre-Filter, paginiertes Cover-Grid.
 */

(function () {
  const grid = document.getElementById('catalog-grid');
  const genreBar = document.getElementById('genre-bar');
  const pagination = document.getElementById('pagination');
  const searchInput = document.getElementById('search-input');

  let state = {
    q: '',
    genre: '',
    page: 1,
    pageSize: 48,
  };
  let searchDebounce = null;

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  async function loadGenres() {
    try {
      const resp = await fetch('/api/genres');
      const genres = await resp.json();
      genreBar.innerHTML = '';

      const allChip = document.createElement('span');
      allChip.className = 'chip active';
      allChip.textContent = 'Alle';
      allChip.addEventListener('click', () => {
        state.genre = '';
        state.page = 1;
        setActiveChip(allChip);
        loadCatalog();
      });
      genreBar.appendChild(allChip);

      genres.forEach(({ genre }) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = genre;
        chip.addEventListener('click', () => {
          state.genre = genre;
          state.page = 1;
          setActiveChip(chip);
          loadCatalog();
        });
        genreBar.appendChild(chip);
      });
    } catch (err) {
      console.warn('Genres konnten nicht geladen werden:', err);
    }
  }

  function setActiveChip(activeEl) {
    genreBar.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    activeEl.classList.add('active');
  }

  function renderCard(item) {
    const div = document.createElement('div');
    div.className = 'card';
    div.addEventListener('click', () => {
      window.location.href = `/serie/${encodeURIComponent(item.slug)}`;
    });

    const coverHtml = item.coverUrl
      ? `<img src="${escapeHtml(item.coverUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
         <div class="placeholder" style="display:none;">🎬</div>`
      : `<div class="placeholder">🎬</div>`;

    div.innerHTML = `
      <div class="card-cover">${coverHtml}</div>
      <div class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
      <div class="card-meta">${escapeHtml((item.genres || []).slice(0, 2).join(' • '))}</div>
    `;
    return div;
  }

  function renderPagination(total) {
    pagination.innerHTML = '';
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (totalPages <= 1) return;

    const makeBtn = (label, page, disabled) => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = label;
      btn.disabled = disabled;
      if (disabled) btn.style.opacity = '0.4';
      btn.addEventListener('click', () => {
        state.page = page;
        loadCatalog();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      return btn;
    };

    pagination.appendChild(makeBtn('← Zurück', state.page - 1, state.page <= 1));
    const info = document.createElement('span');
    info.className = 'card-meta';
    info.style.alignSelf = 'center';
    info.textContent = `Seite ${state.page} / ${totalPages}`;
    pagination.appendChild(info);
    pagination.appendChild(makeBtn('Weiter →', state.page + 1, state.page >= totalPages));
  }

  async function loadCatalog() {
    grid.innerHTML = '<div class="state-message"><span class="spinner"></span>Lädt...</div>';
    pagination.innerHTML = '';

    const params = new URLSearchParams({
      q: state.q,
      genre: state.genre,
      page: state.page,
      pageSize: state.pageSize,
    });

    try {
      const resp = await fetch(`/api/catalog?${params.toString()}`);
      const data = await resp.json();

      if (!data.items || data.items.length === 0) {
        grid.innerHTML = '<div class="state-message">Keine Serien gefunden.</div>';
        return;
      }

      grid.innerHTML = '';
      data.items.forEach((item) => grid.appendChild(renderCard(item)));
      renderPagination(data.total);
    } catch (err) {
      grid.innerHTML = `<div class="state-message">Fehler beim Laden: ${escapeHtml(err.message)}</div>`;
    }
  }

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.q = e.target.value.trim();
      state.page = 1;
      loadCatalog();
    }, 350);
  });

  loadGenres();
  loadCatalog();
})();
