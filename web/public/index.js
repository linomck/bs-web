/**
 * N2nd - Katalog Frontend
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

  function initials(t) {
    return String(t || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }

  function renderCard(item, opts = {}) {
    const div = document.createElement('div');
    div.className = 'card';
    div.addEventListener('click', () => {
      window.location.href = opts.href || `/serie/${encodeURIComponent(item.slug)}`;
    });

    const placeholder = `<div class="placeholder initials">${escapeHtml(initials(item.title))}</div>`;
    const coverHtml = item.coverUrl
      ? `<img src="${escapeHtml(item.coverUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
         ${placeholder.replace('class="placeholder', 'style="display:none;" class="placeholder')}`
      : placeholder;

    const pct = opts.progress ? Math.min(100, Math.round(opts.progress * 100)) : 0;
    div.innerHTML = `
      <div class="card-cover">
        ${coverHtml}
        <div class="overlay">▶</div>
        ${pct ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ''}
        ${opts.onRemove ? '<button class="remove" title="Entfernen">✕</button>' : ''}
      </div>
      <div class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
      <div class="card-meta">${escapeHtml(opts.meta != null ? opts.meta : (item.genres || []).slice(0, 2).join(' • '))}</div>
    `;
    if (opts.onRemove) {
      div.querySelector('.remove').addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onRemove(div);
      });
    }
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
    grid.innerHTML = Array(12).fill('<div class="skeleton"></div>').join('');
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

  // ---------- Such-Screen ----------
  const searchScreen = document.getElementById('search-screen');
  const searchResults = document.getElementById('search-results');
  const searchTitle = document.getElementById('search-title');
  let searchSeq = 0;

  function closeSearch() {
    searchSeq++;
    searchScreen.classList.add('hidden');
    document.body.style.overflow = '';
  }

  async function runSearch(q) {
    const seq = ++searchSeq;
    searchScreen.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    searchTitle.textContent = `Ergebnisse für „${q}"`;
    searchResults.innerHTML = Array(12).fill('<div class="skeleton"></div>').join('');
    try {
      const params = new URLSearchParams({ q, page: 1, pageSize: 96 });
      const data = await (await fetch(`/api/catalog?${params}`)).json();
      if (seq !== searchSeq) return;
      searchResults.innerHTML = '';
      if (!data.items || !data.items.length) {
        searchResults.innerHTML = '<div class="state-message">Keine Serien gefunden.</div>';
        return;
      }
      data.items.forEach((item) => searchResults.appendChild(renderCard(item)));
    } catch (err) {
      if (seq === searchSeq) searchResults.innerHTML = `<div class="state-message">Fehler: ${escapeHtml(err.message)}</div>`;
    }
  }

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const q = e.target.value.trim();
    if (!q) return closeSearch();
    searchDebounce = setTimeout(() => runSearch(q), 300);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      closeSearch();
      searchInput.blur();
    }
  });

  loadGenres();
  loadCatalog();
  // ---------- Startseite: Hero + Reihen ----------
  const heroEl = document.getElementById('hero');
  const rowsEl = document.getElementById('rows');

  function renderHero(h) {
    if (!h) { heroEl.remove(); return; }
    heroEl.classList.remove('skeleton-block');
    const url = `/serie/${encodeURIComponent(h.slug)}`;
    heroEl.innerHTML = `
      <div class="hero-bg" style="background-image:url('${escapeHtml(h.coverUrl)}')"></div>
      <div class="hero-inner">
        <img class="hero-cover" src="${escapeHtml(h.coverUrl)}" alt="">
        <div class="hero-info">
          <h1>${escapeHtml(h.title)}</h1>
          <div class="hero-genres">${escapeHtml([h.years, ...(h.genres || []).slice(0, 3)].filter(Boolean).join(' • '))}</div>
          <p class="hero-desc">${escapeHtml(h.description || '')}</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="/watch?slug=${encodeURIComponent(h.slug)}&season=1&episode=1&title=${encodeURIComponent(h.title)}">▶ Ansehen</a>
            <a class="btn" href="${url}">Details</a>
          </div>
        </div>
      </div>`;
  }

  function addRow(title, items, optsFor) {
    if (!items || !items.length) return null;
    const sec = document.createElement('section');
    sec.className = 'row-section';
    sec.innerHTML = `<h2 class="row-title">${escapeHtml(title)}</h2><div class="row"></div>`;
    const row = sec.querySelector('.row');
    items.forEach((it) => row.appendChild(renderCard(it, optsFor ? optsFor(it, sec) : {})));
    rowsEl.appendChild(sec);
    return sec;
  }

  function fmtResume(p) {
    return `S${p.season}E${p.episode}`;
  }

  async function loadHome() {
    rowsEl.innerHTML = '<section class="row-section"><div class="row">' + Array(8).fill('<div class="skeleton" style="flex:0 0 160px"></div>').join('') + '</div></section>';
    const [progress, home] = await Promise.all([
      fetch('/api/progress').then((r) => r.json()).catch(() => []),
      fetch('/api/home').then((r) => r.json()).catch(() => null),
    ]);
    rowsEl.innerHTML = '';
    if (home) renderHero(home.hero); else heroEl.remove();

    if (Array.isArray(progress) && progress.length) {
      addRow('Weiterschauen', progress, (p, sec) => ({
        meta: fmtResume(p),
        progress: p.duration > 0 ? p.position / p.duration : 0,
        href: `/watch?slug=${encodeURIComponent(p.slug)}&season=${p.season}&episode=${p.episode}&title=${encodeURIComponent(p.title)}&t=${Math.floor(p.position)}`,
        onRemove: (card) => {
          fetch('/api/progress/' + encodeURIComponent(p.slug), { method: 'DELETE' }).catch(() => {});
          card.remove();
          if (!sec.querySelector('.card')) sec.remove();
        },
      }));
    }
    if (home) {
      addRow('Neu im Katalog', home.newest);
      (home.rows || []).forEach((r) => addRow(r.genre, r.items));
    }
  }

  window.addEventListener('scroll', () => {
    document.querySelector('.topnav').classList.toggle('scrolled', window.scrollY > 40);
  }, { passive: true });

  loadHome();

})();
