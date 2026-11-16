import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { cell, expect, test } from "./harness";
import { DEFAULT_SYSTEM_SETTINGS } from "./fixtures/scenario";

const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const menu = (page: Page, name: string) => dialog(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const connectionSentence = /실시간 연결됨|장 닫힘: 체결 없음/;
const noHorizontalScroll = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

async function openDesktop(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("위 막대 단추로 열면 키움 연결이 선택돼 있고 Esc로 닫힌다", async ({ page }) => {
  await openDesktop(page);
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(menu(page, "키움 연결")).toHaveAttribute("aria-selected", "true");
  await expect(dialog(page).getByRole("tabpanel")).toContainText("키움에 연결되어 있습니다");
  await expect(dialog(page).getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("상태 줄의 연결 문장, Alt+쉼표, 명령 찾기로도 열린다", async ({ page }) => {
  await openDesktop(page);
  await page.locator("footer").last().getByRole("button", { name: connectionSentence }).click();
  await expect(menu(page, "키움 연결")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  await page.keyboard.press("Alt+Comma");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  await page.keyboard.press("Control+k");
  await page.getByRole("option", { name: /시스템 설정/ }).click();
  await expect(dialog(page)).toBeVisible();
});

test("방향키와 Home·End로 메뉴를 옮기고 준비 중 메뉴는 고를 수 없다", async ({ page }) => {
  await openDesktop(page);
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(menu(page, "알림 · 텔레그램")).toBeDisabled();
  await expect(menu(page, "재무자료 · DART")).toBeDisabled();
  await expect(menu(page, "알림 · 텔레그램")).toContainText("준비 중");
  await expect(menu(page, "키움 연결")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page, "일반")).toBeFocused();
  await expect(menu(page, "일반")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(menu(page, "데이터 · 저장소")).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu(page, "정보")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu(page, "키움 연결")).toBeFocused();
});

test("일반·데이터·정보는 서버 설정 값을 읽기 전용으로 보인다", async ({ page }) => {
  await openDesktop(page);
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  const panel = dialog(page).getByRole("tabpanel");
  await menu(page, "일반").click();
  await expect(panel).toContainText(DEFAULT_SYSTEM_SETTINGS.bind);
  await expect(panel).toContainText("api.kiwoom.com");
  await menu(page, "데이터 · 저장소").click();
  await expect(panel).toContainText(DEFAULT_SYSTEM_SETTINGS.dbPath);
  await expect(panel).toContainText(DEFAULT_SYSTEM_SETTINGS.keyPath);
  await expect(panel).toContainText("OpenDART 키");
  await menu(page, "정보").click();
  await expect(panel).toContainText(DEFAULT_SYSTEM_SETTINGS.serverVersion);
  await expect(panel.locator("input, textarea, select")).toHaveCount(0);
});

test("연결 상태 메시지가 오면 상태 점과 문장이 바뀐다", async ({ page, scenario }) => {
  await openDesktop(page);
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  const dot = menu(page, "키움 연결").locator(".conn-dot");
  await expect(dot).toHaveAttribute("data-tone", "mint");
  scenario.live.link({ ...scenario.live.kiwoomLink, state: "failed", problem: "authBlocked8050", message: "키움이 지정단말기 인증을 거절했습니다" });
  await expect(dot).toHaveAttribute("data-tone", "red");
  await expect(dialog(page).getByRole("tabpanel")).toContainText("키움이 지정단말기 인증을 거절했습니다");
});

test("열린 채 창이 좁아져도 초점이 창 안에 남고 내용 칸에 이름이 있다", async ({ page }) => {
  await openDesktop(page);
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await menu(page, "일반").click();
  await expect(menu(page, "일반")).toBeFocused();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(dialog(page).getByRole("heading", { name: "일반" })).toBeFocused();
  await expect(dialog(page).getByRole("tabpanel", { name: "일반" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(menu(page, "일반")).toBeFocused();
});

test("위 막대는 좁은 데스크톱 폭에서도 가로로 스크롤되지 않는다", async ({ page }) => {
  for (const width of [768, 770, 800, 1024, 1279, 1280]) {
    await page.setViewportSize({ width, height: 700 });
    await openDesktop(page);
    await expect(page.getByRole("button", { name: "시스템 설정", exact: true })).toBeVisible();
    const bar = page.getByRole("toolbar", { name: "차트 도구 막대" });
    expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth), `${width}px`).toBe(0);
  }
});

test("1440×900 화면", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDesktop(page);
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(dialog(page).getByRole("tabpanel")).toContainText("키움에 연결되어 있습니다");
  await mkdir(path.resolve("../target/ux-screens"), { recursive: true });
  await page.screenshot({ path: path.resolve("../target/ux-screens/system-settings-1440x900.png") });
  const box = await dialog(page).boundingBox();
  expect(Math.round(box!.width)).toBe(940);
  expect(Math.round(box!.height)).toBe(680);
  expect(Math.round((await menu(page, "키움 연결").boundingBox())!.width)).toBeLessThanOrEqual(208);
});

test.describe("360px 폭", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("목록 → 내용 → 목록이 되고 초점이 돌아오며 가로 스크롤이 없다", async ({ page }) => {
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toBeVisible();
    await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("tabpanel")).toHaveCount(0);
    await expect(menu(page, "일반")).toBeVisible();
    expect((await menu(page, "일반").boundingBox())!.height).toBe(48);
    await noHorizontalScroll(page);
    await mkdir(path.resolve("../target/ux-screens"), { recursive: true });
    await page.screenshot({ path: path.resolve("../target/ux-screens/system-settings-360x800-list.png") });

    await menu(page, "일반").click();
    const panel = dialog(page).getByRole("tabpanel");
    await expect(panel).toContainText(DEFAULT_SYSTEM_SETTINGS.bind);
    await expect(menu(page, "일반")).toHaveCount(0);
    await expect(panel.getByRole("heading", { name: "일반" })).toBeFocused();
    await noHorizontalScroll(page);
    await page.screenshot({ path: path.resolve("../target/ux-screens/system-settings-360x800-content.png") });

    await dialog(page).getByRole("button", { name: "‹ 시스템 설정" }).click();
    await expect(menu(page, "일반")).toBeFocused();
    await expect(dialog(page).getByRole("tabpanel")).toHaveCount(0);
    await noHorizontalScroll(page);
  });

  test("상태 줄로 열면 목록을 건너뛰고 키움 연결 내용이 바로 보인다", async ({ page }) => {
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toBeVisible();
    await page.getByRole("status").filter({ hasText: connectionSentence }).getByRole("button").click();
    await expect(dialog(page).getByRole("tabpanel")).toContainText("키움에 연결되어 있습니다");
    await expect(dialog(page).getByRole("heading", { name: "키움 연결" })).toBeFocused();
    await noHorizontalScroll(page);
  });
});
