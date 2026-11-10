import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import type { fontRefreshControl, layoutControls } from "./text-layout-controls-probe";

test("wrapped, padded and rotated text shares paint, hit and bounds for every frame path", async ({ page }, info) => {
  const server = await createServer({ configFile: false, envDir: false, appType: "custom", root: process.cwd(), server: { host: "127.0.0.1", port: 0 } });
  server.middlewares.use("/__text_controls", (_request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><body></body>"); });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Probe server unavailable");
    await page.goto(`http://127.0.0.1:${address.port}/__text_controls`);
    const result: { layouts: ReturnType<typeof layoutControls>; fonts: Awaited<ReturnType<typeof fontRefreshControl>> } = await page.evaluate(async () => {
      const modulePath = "/e2e/text-layout-controls-probe.ts";
      const module = await import(modulePath);
      return { layouts: module.layoutControls(), fonts: await module.fontRefreshControl() };
    });
    await info.attach("text-controls.json", { body: JSON.stringify(result), contentType: "application/json" });
    for (const row of result.layouts) for (const layout of row) {
      if (layout.wrapped) expect(layout.lines.length).toBeGreaterThan(2);
      else expect(layout.lines).toHaveLength(1);
      expect(layout.ink).toBeGreaterThan(0);
      expect(layout.misses).toBe(0);
      expect(layout.outsideBounds).toBe(0);
      expect(layout.paddingHit).toBe("fill");
      expect(layout.selected).toEqual(["text"]);
    }
    expect(result.layouts[0]?.[0]?.vertical).toBe(false);
    expect(result.layouts[1]?.[0]?.vertical).toBe(true);
    expect(result.layouts[2]?.[0]?.overhang).toBe(true);
    expect(result.fonts.afterReady).toBeGreaterThan(2);
    expect(result.fonts.afterLoad).toBe(result.fonts.afterReady + 1);
    expect(result.fonts.afterDetach).toBe(result.fonts.afterLoad);
  } finally { await server.close(); }
});
