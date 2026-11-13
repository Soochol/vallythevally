export async function installDartDisplay(context, base) {
  const origin = new URL(base).origin;
  const id = "01900000-0000-7000-8000-000000000001";
  let layout = { id, name: "DART 진단", arrangement: "1", sync: { crosshair: true, scroll: true }, cells: [{ slot: 0, symbol: "005930", venue: "combined", period: "Y", symbolLink: false, chartSettings: { v: 2, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] } }], updatedAt: 0, revision: 0 };
  const documents = new Map([
    ["/api/ui-state", { lastLayoutId: id, theme: "dark", revision: 0 }],
    ["/api/watchlists", { lists: [{ id: "01900000-0000-7000-8000-000000000002", name: "진단", symbols: [] }], revision: 0 }],
    ["/api/screens", { screens: [], revision: 0 }],
  ]);
  const unexpected = [];
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort("blockedbyclient"); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    if (url.pathname.startsWith("/api/financial-update") || /^\/api\/symbols\/005930\/financial(?:s|-source)$/.test(url.pathname)) { await route.continue(); return; }
    let body;
    if (documents.has(url.pathname)) {
      if (request.method() === "PUT") documents.set(url.pathname, request.postDataJSON());
      body = documents.get(url.pathname);
    } else if (url.pathname === "/api/layouts") body = [{ id, name: layout.name, arrangement: layout.arrangement, updatedAt: 0 }];
    else if (url.pathname === `/api/layouts/${id}`) { if (request.method() === "PUT") layout = request.postDataJSON(); body = layout; }
    else if (url.pathname === "/api/symbols/005930") body = { code: "005930", name: "삼성전자", kind: "common", market: "kospi", nxtEnabled: true };
    else if (url.pathname === "/api/bars") {
      const bars = Array.from({ length: new Date().getFullYear() - 2015 + 1 }, (_, index) => ({ t: Date.UTC(2015 + index, 0, 1, -9) / 1000, o: 100, h: 110, l: 90, c: 105, v: 1000 }));
      body = { symbol: "005930", venue: "combined", period: url.searchParams.get("period") ?? "Y", bars, current: null, nextBefore: null, seq: null };
    } else if (url.pathname === "/api/quotes" || url.pathname === "/api/drawings") body = [];
    else if (url.pathname === "/api/screener/status") body = { lastDay: null, needDay: "20261106", todayAvailable: false, fullHistory: { done: 0, total: 0 }, unconfirmed: 0, update: null };
    else { unexpected.push(`${request.method()} ${url.pathname}`); await route.abort("blockedbyclient"); return; }
    await route.fulfill({ json: body });
  });
  await context.routeWebSocket("**/*", socket => {
    const url = new URL(socket.url());
    if (url.host !== new URL(base).host || url.pathname !== "/api/ws") { unexpected.push(`WebSocket ${url.origin}${url.pathname}`); socket.close(); return; }
    socket.send(JSON.stringify({ type: "hello", protocol: 1, serverTime: Math.floor(Date.now() / 1000), status: { realtime: "live", since: 0, backfilling: false } }));
    socket.onMessage(value => {
      const message = JSON.parse(String(value));
      if (message.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", sub: message.sub, seq: 0, current: null }));
    });
  });
  return () => { if (unexpected.length) throw new Error(`Unexpected DART display traffic: ${unexpected.join(", ")}`); };
}
