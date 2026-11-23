import type { Page } from "@playwright/test";
import { cell, DEFAULT_LAYOUT_ID, expect, firstChart, test, withFirstChart, pickDesktopVenue, expectDesktopVenue, type Scenario } from "./harness";

test("바꾼 종목·거래소·봉 주기가 새로고침 뒤에도 남는다", async ({ page }) => {
  await page.goto("/?symbol=005930");
  const toolbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");

  await pickDesktopVenue(page, "NXT");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/layouts/") && r.ok());
  await toolbar.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "주", exact: true }).click();
  await saved;
  await expect(page.getByRole("contentinfo").getByText(/^저장됨$/)).toBeVisible();

  const expectRestored = async () => {
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 NXT 주");
    await expectDesktopVenue(page, "NXT");
    await expect(toolbar.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "주", exact: true })).toHaveAttribute("aria-pressed", "true");
  };
  await page.reload();
  await expectRestored();


  await page.reload();
  await expectRestored();
});

test("종목을 바꾸면 창 목록과 배치째 저장되고, 새로고침 뒤에도 바뀐 종목과 관심종목·스크리너 창이 남는다", async ({ page, scenario }) => {
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/layouts/") && r.ok());
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
  await saved;

  const stored = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  expect(Object.keys(stored).sort()).toEqual(["id", "name", "placement", "revision", "sync", "updatedAt", "windows"]);
  expect(stored.placement).toEqual({ v: 1, dock: null, canvas: null });
  expect(stored.windows.map((w) => [w.id, w.kind])).toEqual([["cell-0", "chart"], ["watchlist", "watchlist"], ["screener", "screener"]]);
  expect(firstChart(stored)).toMatchObject({ symbol: "005930", venue: "combined", period: "D" });

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.map((w) => w.kind)).toEqual(["chart", "watchlist", "screener"]);
});

async function plantUnsavedLayout(page: Page, scenario: Scenario, extraWindow: Record<string, unknown>) {
  const stored = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const draft = { ...stored, windows: [...withFirstChart(stored, { period: "W" }), extraWindow] };
  const unsaved = { path: `/api/layouts/${DEFAULT_LAYOUT_ID}`, body: JSON.stringify(draft), revision: stored.revision + 1 };
  await page.addInitScript((value) => localStorage.setItem("vv.unsaved.layout", JSON.stringify(value)), unsaved);
}

test("브라우저 미저장본에 옛 개체 목록 창이 있으면 그 창만 빠진 채 복원된다", async ({ page, scenario }) => {
  await plantUnsavedLayout(page, scenario, { id: "objects", link: null, kind: "objects" });
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/layouts/") && r.ok());
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 코스피 주");
  await saved;
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.map((w) => w.kind)).toEqual(["chart", "watchlist", "screener"]);
  expect(firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).period).toBe("W");
});

test("브라우저 미저장본에 모르는 창 종류가 있으면 미저장본을 거절하고 저장된 배치를 연다", async ({ page, scenario }) => {
  await plantUnsavedLayout(page, scenario, { id: "mystery", link: null, kind: "mystery" });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 코스피 일");
  expect(firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).period).toBe("D");
});
