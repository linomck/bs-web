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
})();
