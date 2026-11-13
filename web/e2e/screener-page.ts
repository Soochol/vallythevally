import { selectMinute } from "./select-option";
import type { Locator, Page } from "@playwright/test";
import { cell, chartOf, expect } from "./harness";

export const rail = (page: Page) => page.getByRole("tablist", { name: "오른쪽 패널" });
export const panel = (page: Page) => page.getByRole("complementary", { name: "스크리너" });
export const updateBand = (page: Page) => panel(page).getByLabel("업데이트", { exact: true });
export const storeLine = (page: Page) => panel(page).getByLabel("KRX 일봉 저장소");
export const runButton = (page: Page) => panel(page).getByRole("button", { name: /^(실행|실행 중)$/ }).and(page.locator(":not([role=dialog] *)"));
export const results = (page: Page) => panel(page).getByRole("region", { name: "결과" });
export const excludedLine = (page: Page) => results(page).getByText(/^대상 \d+종목 · 빠짐: /);
export const rows = (page: Page) => results(page).locator("tr[data-code]");
export const editor = (page: Page, title: string) => page.getByRole("region", { name: "조건식 편집", exact: true }).or(page.getByRole("dialog", { name: title }));
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
export const pickVenue = (page: Page, venue: string) => cell(page).getByRole("group", { name: "거래소" }).getByRole("button", { name: venue, exact: true }).click();
export const pickPeriod = (page: Page, period: string) => /^\d+분$/.test(period) ? selectMinute(toolbar(page).getByRole("button", { name: "분봉" }), { label: period }) : toolbar(page).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: period, exact: true }).click();

export async function openScreener(page: Page) {
  const tab = rail(page).getByRole("tab", { name: /^스크리너/ });
  if (await tab.getAttribute("aria-selected") !== "true") await tab.click();
  await expect(panel(page)).toBeVisible();
}

export async function waitForUpdateToFinish(page: Page, lastDay: string) {
  await expect(updateBand(page)).toBeHidden({ timeout: 60_000 });
  await expect(storeLine(page)).toContainText(`KRX 일봉 · ${lastDay}까지`);
}

export async function expectRows(page: Page, expected: readonly (readonly [code: string, name: string, matchedDate: string])[]) {
  await openResultDetails(page);
  await expect(rows(page)).toHaveCount(expected.length);
  await expect.poll(() => rows(page).evaluateAll((li) => li.map((e) => e.getAttribute("data-code")))).toEqual(expected.map(([code]) => code));
  for (const [i, [, name, matchedDate]] of expected.entries()) {
    const row = rows(page).nth(i);
    await expect(row.locator("b")).toHaveText(name);
    await expect(row.getByRole("cell").last()).toHaveText(matchedDate);
  }
}

export async function expectCellOn(page: Page, row: Locator, label: string) {
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${label}`);
  await expect(row.getByRole("button")).toHaveAttribute("aria-current", "true");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
}

export const savedTo = (page: Page, path: string) => page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === path && r.ok());

export async function openResultDetails(page: Page) {
  const details = results(page).locator("details");
  if (await details.count() && await details.getAttribute("open") === null) await details.locator("summary").click();
}

export const screenChooser = (page: Page) => panel(page).getByRole("button", { name: "조건식 고르기", exact: true }).or(panel(page).getByRole("button", { name: /^조건식: / }));
