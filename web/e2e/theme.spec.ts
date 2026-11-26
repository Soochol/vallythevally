import type { Page } from "@playwright/test";
import { cell, expect, test } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const root = (page: Page) => page.locator("html");
const themeOption = (page: Page, name: "다크" | "화이트") => dialog(page).getByRole("radio", { name, exact: true });
const densityOption = (page: Page, name: "기본" | "촘촘") => dialog(page).getByRole("radio", { name, exact: true });

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function openGeneralSettings(page: Page) {
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await dialog(page).getByRole("tab", { name: /^일반/ }).click();
}

const bgToken = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase());

test("처음에는 다크 테마이고 시스템 설정에서 화이트로 바꾸면 즉시 반영된다", async ({ page }) => {
  await open(page);
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => bgToken(page)).toBe("#0b0b0b");
  await openGeneralSettings(page);
  await expect(themeOption(page, "다크")).toBeChecked();
  await expect(themeOption(page, "화이트")).not.toBeChecked();
  await themeOption(page, "화이트").click();
  await expect(dialog(page)).toBeVisible();
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect.poll(() => bgToken(page)).toBe("#f8f7f4");
  await themeOption(page, "다크").click();
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => bgToken(page)).toBe("#0b0b0b");
});

test("화이트 테마와 기본 밀도를 고른 뒤 새로 고침하고 다른 페이지로 옮겨도 유지된다", async ({ page }) => {
  await open(page);
  await openGeneralSettings(page);
  await themeOption(page, "화이트").click();
  await densityOption(page, "기본").click();
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect(root(page)).toHaveAttribute("data-density", "regular");
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect(root(page)).toHaveAttribute("data-density", "regular");
  await expect.poll(() => bgToken(page)).toBe("#f8f7f4");
  await openGeneralSettings(page);
  await expect(themeOption(page, "화이트")).toBeChecked();
  await expect(densityOption(page, "기본")).toBeChecked();
  await page.keyboard.press("Escape");
  for (const path of ["/market", "/heatmap", "/etf"]) {
    await page.goto(path);
    await expect(root(page)).toHaveAttribute("data-theme", "light");
    await expect.poll(() => bgToken(page)).toBe("#f8f7f4");
  }
});

test("저장소를 쓸 수 없어도 다크로 열고 화이트 전환에 오류가 나지 않는다", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await openGeneralSettings(page);
  await themeOption(page, "화이트").click();
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});
