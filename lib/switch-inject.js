// Runs at document_start on app.devin.ai — synchronously, before any page
// script executes. During an account switch the service worker navigates here
// with the target session in the URL fragment (#das_auth=...). Fragments are
// never sent to the server; we read it, write localStorage, and strip it, all
// before the SPA boots its auth check — so it can't race us and bounce to the
// Auth0 login page.
(() => {
  const m = /(?:^|[#&])das_auth=([^&]+)/.exec(location.hash);
  if (!m) return;
  try {
    const auth1_session = decodeURIComponent(m[1]);
    // Sanity check: must be JSON with a token.
    const parsed = JSON.parse(auth1_session);
    if (!parsed || !parsed.token) return;
    for (const store of [localStorage, sessionStorage]) {
      const stale = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith("auth1")) stale.push(k);
      }
      stale.forEach((k) => store.removeItem(k));
    }
    localStorage.setItem("auth1_session", auth1_session);
  } catch {
    // best-effort; a failed inject just means the user stays on the login page
  } finally {
    history.replaceState(null, "", location.pathname + location.search);
  }
})();
