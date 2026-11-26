import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { seedHeatmapThemes, HEATMAP_TABLE } from "./fixtures/heatmap-data";
import type { PublicSession } from "./fixtures/public-mode-data";
import { expect, test } from "./screener-harness";
import { openScreener, panel } from "./screener-page";

const SESSION: PublicSession = { provider: "google", createdAt: Date.parse("2026-11-09T09:30:00+09:00") / 1000 };
const POLICY_FILE = path.resolve("../crates/server/src/public/csp.txt");

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

async function enforcePolicy(page: Page) {
  const policy = (await readFile(POLICY_FILE, "utf8")).trim();
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy } });
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`);
    });
  });
  const reported: string[] = [];
  page.on("console", (message) => { if (/content security policy|refused to/i.test(message.text())) reported.push(message.text()); });
  page.on("pageerror", (error) => { if (/content security policy|refused to/i.test(error.message)) reported.push(error.message); });
  return {
    async expectNoViolations() {
      expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([]);
      expect(reported).toEqual([]);
    },
  };
}

test("읽은 정책이 비어 있지 않고 script-src는 넓지 않다", async () => {
  const policy = await readFile(POLICY_FILE, "utf8");
  const script = policy.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src"));
  expect(script).toBe("script-src 'self' 'wasm-unsafe-eval'");
});

test("붙인 정책이 실제로 적용돼 끼어든 인라인 스크립트를 막고 위반으로 센다", async ({ page, scenario }) => {
  await enforcePolicy(page);
  scenario.publicMode.enable(null);
  await page.goto("/");
  await expect(page.getByTestId("landing")).toBeVisible();
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__injected = true";
    document.head.append(script);
  });
  await expect.poll(() => page.evaluate(() => window.__cspViolations ?? [])).toEqual([expect.stringContaining("script-src")]);
  expect(await page.evaluate(() => "__injected" in window)).toBe(false);
});

test("로그인 전 랜딩은 정책 위반 없이 열린다", async ({ page, scenario }) => {
  const csp = await enforcePolicy(page);
  scenario.publicMode.enable(null);
  await page.goto("/");
  await expect(page.getByTestId("landing")).toBeVisible();
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "로그인", exact: true })).toBeVisible();
  await csp.expectNoViolations();
});

test("로그인 뒤 작업 공간과 시스템 설정은 정책 위반 없이 돈다", async ({ page, scenario }) => {
  const csp = await enforcePolicy(page);
  scenario.publicMode.enable(SESSION);
  await page.goto("/");
  await expect(page.getByRole("complementary", { name: "관심종목" })).toBeVisible();
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "시스템 설정", exact: true }).getByRole("tab", { name: "단축키" })).toBeVisible();
  await csp.expectNoViolations();
});

test("스크리너 페이지는 정책 위반 없이 돈다", async ({ page, scenario }) => {
  const csp = await enforcePolicy(page);
  scenario.publicMode.enable(SESSION);
  await page.goto("/");
  await openScreener(page);
  await expect(panel(page)).toBeVisible();
  await csp.expectNoViolations();
});

test("히트맵 페이지는 정책 위반 없이 돈다", async ({ page, scenario }) => {
  const csp = await enforcePolicy(page);
  scenario.publicMode.enable(SESSION);
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  await page.goto("/heatmap");
  await expect(page.getByRole("main", { name: "히트맵", exact: true }).locator('.hm-list-row[data-code="005930"]')).toBeVisible();
  await csp.expectNoViolations();
});
