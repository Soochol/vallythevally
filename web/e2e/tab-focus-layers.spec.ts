import type { Locator, Page } from "@playwright/test";
import type { AccountStatus } from "../src/api/generated/AccountStatus";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import { CONNECTED_KIWOOM, SYNCED } from "./fixtures/scenario";
import { cell, expect, pollSaved, test, windowTab } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

const LOGIN_MARKER = "vv.login-started";
const NO_KEY: KiwoomLinkStatus = { ...CONNECTED_KIWOOM, keySource: "none", appKeyTail: null, state: "noKey", message: "키움 키가 없습니다", realtimeRegistered: null, symbolCount: null };
const SIGNED_IN: AccountStatus = { state: "signed_in", provider: "google", accountId: "0123456789abcdef0123", signedInAt: 1_762_650_000, sync: SYNCED };
const SIGNED_OUT: AccountStatus = { state: "signed_out" };

async function keepsFocus(page: Page, target: Locator) {
  await target.focus();
  await expect(target).toBeFocused();
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(target).toBeFocused();
  }
}

test("드로잉 스타일 막대와 알림에서도 Tab은 초점을 옮기지 않는다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const bounds = await cell(page).boundingBox();
  if (!bounds) throw new Error("차트 영역이 없습니다");
  await cell(page).focus();
  await page.keyboard.press("H");
  await page.mouse.click(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.3);
  await pollSaved(() => scenario.documents.drawings("005930").length).toBe(1);

  const toolbar = page.getByRole("toolbar", { name: "드로잉 스타일" });
  const widthButton = toolbar.getByRole("combobox", { name: "선 굵기" });
  await expect(widthButton).toBeVisible();
  await widthButton.click();
  await page.getByRole("menu", { name: "선 굵기", exact: true }).getByRole("menuitemradio", { name: "2px", exact: true }).click();
  await expect(widthButton).toBeFocused();
  for (const key of ["Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(widthButton).toBeFocused();
  }

  await windowTab(page, "관심종목").locator("..").getByRole("button", { name: "관심종목 닫기", exact: true }).click();
  const undoButton = page.getByRole("status").filter({ hasText: "관심종목 창을 닫았습니다" }).getByRole("button", { name: "되돌리기", exact: true });
  await expect(undoButton).toBeVisible();
  await keepsFocus(page, undoButton);
});

test("시스템 설정 안에서는 Tab이 초점을 옮긴다", async ({ page }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "시스템 설정", exact: true });
  const firstTab = dialog.getByRole("tab", { name: /^증권사 · 계좌/ });
  await expect(firstTab).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstTab).not.toBeFocused();
  await expect(dialog.locator(":focus")).toHaveCount(1);
});

test("설정 마법사 안에서는 Tab이 초점을 옮긴다", async ({ page, scenario }) => {
  scenario.live.account = SIGNED_IN;
  scenario.live.kiwoomLink = NO_KEY;
  await page.addInitScript((key) => sessionStorage.setItem(key, "1"), LOGIN_MARKER);
  await page.goto("/");
  const wizard = page.getByRole("dialog", { name: "처음 설정", exact: true });
  const later = wizard.getByRole("button", { name: "나중에 하기", exact: true });
  await expect(later).toBeVisible();
  await later.focus();
  await expect(later).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(later).not.toBeFocused();
  await expect(wizard.locator(":focus")).toHaveCount(1);
});

test("로그인 창 안에서는 Tab이 초점을 옮긴다", async ({ page, scenario }) => {
  scenario.live.account = SIGNED_OUT;
  await page.goto("/");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "로그인", exact: true });
  const google = dialog.getByRole("button", { name: "Google로 로그인" });
  const naver = dialog.getByRole("button", { name: "네이버로 로그인" });
  await expect(google).toBeVisible();
  await google.focus();
  await expect(google).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(naver).toBeFocused();
});
