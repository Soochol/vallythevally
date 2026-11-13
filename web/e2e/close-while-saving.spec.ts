import { createServer } from "node:http";
import type { BrowserContext } from "@playwright/test";
import type { LayoutInput } from "../src/api/generated/LayoutInput";
import { cell, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

async function useLayoutEndpoint(context: BrowserContext, origin: string): Promise<void> {
  await context.addInitScript(origin => {
    const send = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      return send(url.pathname.startsWith("/api/layouts/") ? new URL(url.pathname, origin).href : input, options);
    };
  }, origin);
  await context.route(url => url.origin === origin, route => route.continue());
}

test("앞 저장이 끝나기 전에 탭을 닫아도 마지막 편집이 HTTP로 저장된다", async ({ scenario, browser, context, page, baseURL }) => {
  let stored = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  let release = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let received = () => {};
  const firstPut = new Promise<void>(resolve => { received = resolve; });
  let held = false;
  const endpoint = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET, PUT, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("content-type", "application/json");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const value: LayoutInput = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!held && value.cells[0]?.period === "W") { held = true; received(); await blocked; }
      if (value.revision > stored.revision) stored = { ...value, updatedAt: Math.floor(Date.now() / 1000) };
      else response.statusCode = 409;
    }
    if (!response.destroyed) response.end(JSON.stringify(stored));
  });
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  const address = endpoint.address();
  if (address === null || typeof address === "string") throw new Error("Missing layout endpoint address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await useLayoutEndpoint(context, origin);
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
    await expect(page.getByRole("contentinfo")).toContainText("자동 저장됨");
    const periods = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" });
    await periods.getByRole("button", { name: "주", exact: true }).click();
    await firstPut;
    await periods.getByRole("button", { name: "월", exact: true }).click();
    await context.unrouteAll({ behavior: "ignoreErrors" });
    await page.close();
    await expect.poll(() => stored.cells[0]?.period).toBe("M");
    release();
    const fresh = await browser.newContext({ baseURL });
    try {
      await scenario.install(fresh);
      await useLayoutEndpoint(fresh, origin);
      const reopened = await fresh.newPage();
      await reopened.goto("/");
      await expect(cell(reopened)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 월");
    } finally { await fresh.close(); }
  } finally {
    release();
    endpoint.closeAllConnections();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});
