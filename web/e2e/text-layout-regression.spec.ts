import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import { textProbe } from "./text-layout-probe";

test("visible hline glyph pixels share the painted text hit and bounds", async ({ page }, info) => {
  const server = await createServer({ configFile: false, envDir: false, appType: "custom", root: process.cwd(), server: { host: "127.0.0.1", port: 0 } });
  server.middlewares.use("/__text_probe", (_request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><body></body>"); });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Probe server unavailable");
    await page.goto(`http://127.0.0.1:${address.port}/__text_probe`);
    const result: ReturnType<typeof textProbe> = await page.evaluate(async () => {
      const modulePath = "/e2e/text-layout-probe.ts";
      const module = await import(modulePath);
      return module.textProbe();
    });
    await page.screenshot({ path: info.outputPath("hline-text-hit.png") });
    await info.attach("text-hit.json", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.ink).toBeGreaterThan(0);
    expect(result.hit).toBe("fill");
    expect(result.bounds.x1).toBeLessThanOrEqual(result.at.x);
    expect(result.bounds.x2).toBeGreaterThanOrEqual(result.at.x);
  } finally { await server.close(); }
});
