import type { Page } from "@playwright/test";
import { cell, expect, test } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

type ThemeLabel = "다크 (Editorial)" | "화이트 (Editorial)" | "소프트 벤토" | "플로팅 글래스";

const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const root = (page: Page) => page.locator("html");
const themeOption = (page: Page, name: ThemeLabel) => dialog(page).getByRole("radio", { name, exact: true });
const densityOption = (page: Page, name: "기본" | "촘촘") => dialog(page).getByRole("radio", { name, exact: true });

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function openGeneralSettings(page: Page) {
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await dialog(page).getByRole("tab", { name: /^일반/ }).click();
}

const cssToken = (page: Page, name: string) =>
  page.evaluate((token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim().toLowerCase(), name);

test("처음에는 다크 테마이고 시스템 설정에서 4종 테마를 바꾸면 즉시 반영된다", async ({ page }) => {
  await open(page);
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#0b0b0b");
  await openGeneralSettings(page);
  await expect(themeOption(page, "다크 (Editorial)")).toBeChecked();
  await expect(themeOption(page, "화이트 (Editorial)")).not.toBeChecked();
  await expect(themeOption(page, "소프트 벤토")).not.toBeChecked();
  await expect(themeOption(page, "플로팅 글래스")).not.toBeChecked();

  await themeOption(page, "화이트 (Editorial)").click();
  await expect(dialog(page)).toBeVisible();
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#f8f7f4");

  await themeOption(page, "소프트 벤토").click();
  await expect(root(page)).toHaveAttribute("data-theme", "bento");
  await expect.poll(() => cssToken(page, "--accent")).toBe("#42e3a8");
  await expect.poll(() => cssToken(page, "--r-l")).toBe("16px");
  await expect.poll(() => cssToken(page, "--r-pill")).toBe("999px");
  await expect(page.locator(".dock-group").first()).toHaveCSS("border-radius", "16px");
  await expect(page.locator(".desktop-topbar .shell-search")).toHaveCSS("border-radius", "999px");

  await themeOption(page, "플로팅 글래스").click();
  await expect(root(page)).toHaveAttribute("data-theme", "glass");
  await expect.poll(() => cssToken(page, "--accent")).toBe("#b49bff");
  await expect.poll(() => cssToken(page, "--r-l")).toBe("12px");
  await expect.poll(() => cssToken(page, "--glass-blur")).toBe("blur(22px)");
  await expect(page.locator(".dock-group").first()).toHaveCSS("border-radius", "12px");
  await expect(page.locator(".dock-group").first()).toHaveCSS("backdrop-filter", "blur(22px)");

  await themeOption(page, "다크 (Editorial)").click();
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#0b0b0b");
});

test("화이트 테마와 기본 밀도를 고른 뒤 새로 고침하고 다른 페이지로 옮겨도 유지된다", async ({ page }) => {
  await open(page);
  await openGeneralSettings(page);
  await themeOption(page, "화이트 (Editorial)").click();
  await densityOption(page, "기본").click();
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect(root(page)).toHaveAttribute("data-density", "regular");
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect(root(page)).toHaveAttribute("data-density", "regular");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#f8f7f4");
  await openGeneralSettings(page);
  await expect(themeOption(page, "화이트 (Editorial)")).toBeChecked();
  await expect(densityOption(page, "기본")).toBeChecked();
  await page.keyboard.press("Escape");
  for (const path of ["/market", "/heatmap", "/etf"]) {
    await page.goto(path);
    await expect(root(page)).toHaveAttribute("data-theme", "light");
    await expect.poll(() => cssToken(page, "--bg")).toBe("#f8f7f4");
  }
});

for (const entry of [
  { label: "소프트 벤토" as const, id: "bento", accent: "#42e3a8", radius: "16px", chartBg: "#121a26" },
  { label: "플로팅 글래스" as const, id: "glass", accent: "#b49bff", radius: "12px", chartBg: "#101423" },
]) {
  test(`${entry.label} 테마를 고른 뒤 새로 고침하고 다른 페이지로 옮겨도 유지된다`, async ({ page }) => {
    await open(page);
    await openGeneralSettings(page);
    await themeOption(page, entry.label).click();
    await expect(root(page)).toHaveAttribute("data-theme", entry.id);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("vally.theme"))).toBe(entry.id);
    await expect.poll(() => cssToken(page, "--chart-bg")).toBe(entry.chartBg);
    await page.reload();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(root(page)).toHaveAttribute("data-theme", entry.id);
    await expect.poll(() => cssToken(page, "--accent")).toBe(entry.accent);
    await expect(page.locator(".dock-group").first()).toHaveCSS("border-radius", entry.radius);
    await openGeneralSettings(page);
    await expect(themeOption(page, entry.label)).toBeChecked();
    await page.keyboard.press("Escape");
    for (const path of ["/market", "/heatmap", "/etf"]) {
      await page.goto(path);
      await expect(root(page)).toHaveAttribute("data-theme", entry.id);
      await expect.poll(() => cssToken(page, "--accent")).toBe(entry.accent);
    }
  });
}

test("저장소를 쓸 수 없어도 다크로 열고 테마 전환에 오류가 나지 않는다", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await openGeneralSettings(page);
  await themeOption(page, "소프트 벤토").click();
  await expect(root(page)).toHaveAttribute("data-theme", "bento");
  await themeOption(page, "플로팅 글래스").click();
  await expect(root(page)).toHaveAttribute("data-theme", "glass");
  expect(errors).toEqual([]);
});
