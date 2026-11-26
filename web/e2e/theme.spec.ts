import type { Page } from "@playwright/test";
import { cell, expect, test } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

type StyleLabel = "에디토리얼" | "소프트 벤토" | "카본 벤토" | "플로팅 글래스" | "포레스트";
type ModeLabel = "다크" | "화이트";

const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const root = (page: Page) => page.locator("html");
const styleOption = (page: Page, name: StyleLabel) => dialog(page).getByRole("radiogroup", { name: "스타일", exact: true }).getByRole("radio", { name, exact: true });
const modeOption = (page: Page, name: ModeLabel) => dialog(page).getByRole("radiogroup", { name: "색상 모드", exact: true }).getByRole("radio", { name, exact: true });
const densityOption = (page: Page, name: "기본" | "촘촘") => dialog(page).getByRole("radiogroup", { name: "목록 밀도", exact: true }).getByRole("radio", { name, exact: true });

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function openGeneralSettings(page: Page) {
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await dialog(page).getByRole("tab", { name: /^일반/ }).click();
}

const cssToken = (page: Page, name: string) =>
  page.evaluate((token) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim().toLowerCase();
    return /^#[0-9a-f]{3}$/.test(value) ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}` : value;
  }, name);

test("처음에는 에디토리얼 다크이고 5 스타일 × 2 모드 10개 조합을 바꾸면 즉시 반영된다", async ({ page }) => {
  await open(page);
  await expect(root(page)).toHaveAttribute("data-style", "editorial");
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#0b0b0b");

  await openGeneralSettings(page);
  await expect(styleOption(page, "에디토리얼")).toBeChecked();
  await expect(styleOption(page, "소프트 벤토")).not.toBeChecked();
  await expect(styleOption(page, "카본 벤토")).not.toBeChecked();
  await expect(styleOption(page, "플로팅 글래스")).not.toBeChecked();
  await expect(styleOption(page, "포레스트")).not.toBeChecked();
  await expect(modeOption(page, "다크")).toBeChecked();
  await expect(modeOption(page, "화이트")).not.toBeChecked();

  await modeOption(page, "화이트").click();
  await expect(dialog(page)).toBeVisible();
  await expect(root(page)).toHaveAttribute("data-style", "editorial");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#f8f7f4");

  await styleOption(page, "소프트 벤토").click();
  await expect(root(page)).toHaveAttribute("data-style", "bento");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#f2f4f6");
  await expect.poll(() => cssToken(page, "--surface")).toBe("#ffffff");
  await expect.poll(() => cssToken(page, "--chart-bg")).toBe("#ffffff");
  await expect.poll(() => cssToken(page, "--accent")).toBe("#006953");
  await expect.poll(() => cssToken(page, "--r-l")).toBe("16px");
  await expect(page.locator(".dock-group").first()).toHaveCSS("border-radius", "16px");
  await expect(page.locator(".desktop-topbar .shell-search")).toHaveCSS("border-radius", "999px");

  await modeOption(page, "다크").click();
  await expect(root(page)).toHaveAttribute("data-style", "bento");
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#06080b");
  await expect.poll(() => cssToken(page, "--chart-bg")).toBe("#0b0e14");
  await expect.poll(() => cssToken(page, "--surface")).toBe("#0f1319");
  await expect.poll(() => cssToken(page, "--accent")).toBe("#42e3a8");

  await styleOption(page, "카본 벤토").click();
  await expect(root(page)).toHaveAttribute("data-style", "carbon");
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#000000");
  await expect.poll(() => cssToken(page, "--chart-bg")).toBe("#060708");
  await expect.poll(() => cssToken(page, "--surface")).toBe("#0b0c0e");
  await expect.poll(() => cssToken(page, "--accent")).toBe("#42e3a8");
  await expect.poll(() => cssToken(page, "--r-l")).toBe("16px");
  await expect(page.locator(".dock-group").first()).toHaveCSS("border-radius", "16px");
  await expect(page.locator(".desktop-topbar .shell-search")).toHaveCSS("border-radius", "999px");

  await modeOption(page, "화이트").click();
  await expect(root(page)).toHaveAttribute("data-style", "carbon");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#f3f4f5");
  await expect.poll(() => cssToken(page, "--surface")).toBe("#ffffff");
  await expect.poll(() => cssToken(page, "--accent")).toBe("#006953");

  await modeOption(page, "다크").click();
  await styleOption(page, "플로팅 글래스").click();
  await expect(root(page)).toHaveAttribute("data-style", "glass");
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => cssToken(page, "--accent")).toBe("#b49bff");
  await expect.poll(() => cssToken(page, "--r-l")).toBe("12px");
  await expect.poll(() => cssToken(page, "--glass-blur")).toBe("blur(22px)");
  await expect(page.locator(".dock-group").first()).toHaveCSS("border-radius", "12px");
  await expect(page.locator(".dock-group").first()).toHaveCSS("backdrop-filter", "blur(22px)");

  await modeOption(page, "화이트").click();
  await expect(root(page)).toHaveAttribute("data-style", "glass");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#eceff8");
  await expect.poll(() => cssToken(page, "--accent")).toBe("#5a38c8");
  await expect.poll(() => cssToken(page, "--glass-blur")).toBe("blur(22px)");
  await expect(page.locator(".dock-group").first()).toHaveCSS("backdrop-filter", "blur(22px)");

  await styleOption(page, "포레스트").click();
  await expect(root(page)).toHaveAttribute("data-style", "forest");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#eef2eb");
  await expect.poll(() => cssToken(page, "--surface")).toBe("#f8faf6");
  await expect.poll(() => cssToken(page, "--accent")).toBe("#226630");
  await expect.poll(() => cssToken(page, "--r-l")).toBe("8px");
  await expect(page.locator(".dock-group").first()).toHaveCSS("border-radius", "8px");

  await modeOption(page, "다크").click();
  await expect(root(page)).toHaveAttribute("data-style", "forest");
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#080b09");
  await expect.poll(() => cssToken(page, "--surface")).toBe("#141914");
  await expect.poll(() => cssToken(page, "--accent")).toBe("#c7f36b");

  await styleOption(page, "에디토리얼").click();
  await expect(root(page)).toHaveAttribute("data-style", "editorial");
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => cssToken(page, "--bg")).toBe("#0b0b0b");
});

const PERSIST_CASES = [
  { styleLabel: "에디토리얼" as const, modeLabel: "화이트" as const, style: "editorial", mode: "light", key: "editorial-light", bg: "#f8f7f4", chartBg: "#f8f7f4", accent: "#141412", radius: "0px" },
  { styleLabel: "소프트 벤토" as const, modeLabel: "다크" as const, style: "bento", mode: "dark", key: "bento-dark", bg: "#06080b", chartBg: "#0b0e14", accent: "#42e3a8", radius: "16px" },
  { styleLabel: "소프트 벤토" as const, modeLabel: "화이트" as const, style: "bento", mode: "light", key: "bento-light", bg: "#f2f4f6", chartBg: "#ffffff", accent: "#006953", radius: "16px" },
  { styleLabel: "카본 벤토" as const, modeLabel: "다크" as const, style: "carbon", mode: "dark", key: "carbon-dark", bg: "#000000", chartBg: "#060708", accent: "#42e3a8", radius: "16px" },
  { styleLabel: "카본 벤토" as const, modeLabel: "화이트" as const, style: "carbon", mode: "light", key: "carbon-light", bg: "#f3f4f5", chartBg: "#ffffff", accent: "#006953", radius: "16px" },
  { styleLabel: "플로팅 글래스" as const, modeLabel: "화이트" as const, style: "glass", mode: "light", key: "glass-light", bg: "#eceff8", chartBg: "#f8f9fe", accent: "#5a38c8", radius: "12px" },
  { styleLabel: "포레스트" as const, modeLabel: "다크" as const, style: "forest", mode: "dark", key: "forest-dark", bg: "#080b09", chartBg: "#080b09", accent: "#c7f36b", radius: "8px" },
  { styleLabel: "포레스트" as const, modeLabel: "화이트" as const, style: "forest", mode: "light", key: "forest-light", bg: "#eef2eb", chartBg: "#fafbf8", accent: "#226630", radius: "8px" },
] as const;

for (const entry of PERSIST_CASES) {
  test(`${entry.styleLabel} ${entry.modeLabel} 조합과 밀도를 고른 뒤 새로 고침하고 다른 페이지로 옮겨도 유지된다`, async ({ page }) => {
    await open(page);
    await openGeneralSettings(page);
    await styleOption(page, entry.styleLabel).click();
    await modeOption(page, entry.modeLabel).click();
    await densityOption(page, "기본").click();
    await expect(root(page)).toHaveAttribute("data-style", entry.style);
    await expect(root(page)).toHaveAttribute("data-theme", entry.mode);
    await expect(root(page)).toHaveAttribute("data-density", "regular");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("vally.theme"))).toBe(entry.key);
    await expect.poll(() => cssToken(page, "--bg")).toBe(entry.bg);
    await expect.poll(() => cssToken(page, "--chart-bg")).toBe(entry.chartBg);

    await page.reload();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(root(page)).toHaveAttribute("data-style", entry.style);
    await expect(root(page)).toHaveAttribute("data-theme", entry.mode);
    await expect(root(page)).toHaveAttribute("data-density", "regular");
    await expect.poll(() => cssToken(page, "--accent")).toBe(entry.accent);
    await expect(page.locator(".dock-group").first()).toHaveCSS("border-radius", entry.radius);

    await openGeneralSettings(page);
    await expect(styleOption(page, entry.styleLabel)).toBeChecked();
    await expect(modeOption(page, entry.modeLabel)).toBeChecked();
    await expect(densityOption(page, "기본")).toBeChecked();
    await page.keyboard.press("Escape");

    for (const path of ["/market", "/heatmap", "/etf"]) {
      await page.goto(path);
      await expect(root(page)).toHaveAttribute("data-style", entry.style);
      await expect(root(page)).toHaveAttribute("data-theme", entry.mode);
      await expect.poll(() => cssToken(page, "--accent")).toBe(entry.accent);
    }
  });
}

const LEGACY_CASES = [
  { legacy: "light", style: "editorial", mode: "light", styleLabel: "에디토리얼" as const, modeLabel: "화이트" as const },
  { legacy: "bento", style: "bento", mode: "dark", styleLabel: "소프트 벤토" as const, modeLabel: "다크" as const },
  { legacy: "glass", style: "glass", mode: "dark", styleLabel: "플로팅 글래스" as const, modeLabel: "다크" as const },
] as const;

for (const entry of LEGACY_CASES) {
  test(`기존 vally.theme=${entry.legacy} 저장값을 스타일과 색상 모드로 자동 매핑한다`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("vally.theme", value), entry.legacy);
    await open(page);
    await expect(root(page)).toHaveAttribute("data-style", entry.style);
    await expect(root(page)).toHaveAttribute("data-theme", entry.mode);
    await openGeneralSettings(page);
    await expect(styleOption(page, entry.styleLabel)).toBeChecked();
    await expect(modeOption(page, entry.modeLabel)).toBeChecked();
  });
}

test("저장소를 쓸 수 없어도 에디토리얼 다크로 열고 스타일·모드 전환에 오류가 나지 않는다", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await expect(root(page)).toHaveAttribute("data-style", "editorial");
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  await openGeneralSettings(page);
  await styleOption(page, "소프트 벤토").click();
  await modeOption(page, "화이트").click();
  await expect(root(page)).toHaveAttribute("data-style", "bento");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await styleOption(page, "포레스트").click();
  await expect(root(page)).toHaveAttribute("data-style", "forest");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  expect(errors).toEqual([]);
});
