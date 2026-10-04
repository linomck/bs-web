/* Zeigt oben rechts in der Topnav, ob die BS-Web-Direct-Extension aktiv ist. */
(function () {
  const nav = document.querySelector('.topnav');
  if (!nav) return;
  const el = document.createElement('a');
  el.className = 'ext-status';
  el.textContent = 'Extension prüfen...';
  nav.appendChild(el);

  function setState(ok) {
    el.classList.toggle('ok', ok);
    if (ok) {
      el.removeAttribute('href');
      el.textContent = '● Extension aktiv';
    } else {
      el.href = '#';
      el.textContent = 'Extension installieren';
      el.onclick = (e) => {
        e.preventDefault();
        alert('Installations-Link folgt (Dummy).');
      };
    }
  }

  (async () => {
    try {
      if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) return setState(false);
      const id = (await (await fetch('/api/config')).json()).extensionId;
      chrome.runtime.sendMessage(id, { type: 'ping' }, (resp) => {
        void chrome.runtime.lastError;
        setState(!!(resp && resp.ok));
      });
    } catch (e) {
      setState(false);
    }
  })();

  fetch('/api/me').then((r) => r.json()).then((me) => {
    if (!me.authEnabled) return;
    const label = me.name || me.email || 'Konto';
    const u = document.createElement('div');
    u.className = 'user-chip';
    const ini = document.createElement('span');
    ini.className = 'avatar';
    ini.textContent = label.trim().slice(0, 1).toUpperCase();
    u.appendChild(ini);
    if (me.picture) {
      const img = new Image();
      img.className = 'avatar';
      img.alt = '';
      img.onload = () => ini.replaceWith(img);
      img.src = me.picture;
    }
    const t = document.createElement('span');
    t.textContent = label;
    u.appendChild(t);
    nav.appendChild(u);
  }).catch(() => {});
})();
