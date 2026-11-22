window.__serverModeProbe = fetch("/api/server-mode", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) })
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null);
