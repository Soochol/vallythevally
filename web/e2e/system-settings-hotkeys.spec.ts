import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";

const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const panel = (page: Page) => dialog(page).getByRole("tabpanel");
const row = (page: Page, action: string) => panel(page).locator(`li[data-action="${action}"]`);
const periodButton = (page: Page, name: string) => page.getByRole("group", { name: "봉 주기", exact: true }).getByRole("button", { name, exact: true });
const savedHotkeys = (scenario: { documents: { uiState(): unknown } }) => (scenario.documents.uiState() as { hotkeys?: Record<string, string[]> }).hotkeys;

async function openChart(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
}

async function openHotkeys(page: Page) {
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await dialog(page).getByRole("tab", { name: "단축키" }).click();
  await expect(panel(page).getByRole("searchbox", { name: "단축키 찾기" })).toBeVisible();
}

async function record(page: Page, action: string, name: string, key: string) {
  await row(page, action).getByRole("button", { name: `${name}에 키 더하기` }).click();
  await expect(row(page, action)).toContainText("키를 누르세요 · Esc 취소");
  await page.keyboard.press(key);
}

test.use({ viewport: { width: 1440, height: 900 } });

test("단축키 탭은 일반 다음에 있고 기본 키, 없음, 바꿀 수 없는 키 묶음을 보인다", async ({ page }) => {
  await openChart(page);
  await openHotkeys(page);
  const tabs = await dialog(page).getByRole("tab").allInnerTexts();
  expect(tabs.map((t) => t.trim()).indexOf("단축키")).toBe(tabs.map((t) => t.trim()).indexOf("일반") + 1);
  await expect(row(page, "period:D")).toContainText("D");
  await expect(row(page, "search")).toContainText("/");
  await expect(row(page, "search")).toContainText("Ctrl+K");
  await expect(row(page, "period:10m")).toContainText("없음");
  await expect(panel(page).getByRole("region", { name: "바꿀 수 없는 키" })).toBeVisible();
});

test("일에 Q를 더하고 D를 빼면 Q가 일이 되고 새로고침 뒤에도 남는다", async ({ page, scenario }) => {
  await openChart(page);
  await openHotkeys(page);
  await record(page, "period:D", "일", "Q");
  await expect(row(page, "period:D").getByRole("button", { name: "일에서 Q 빼기" })).toBeVisible();
  await expect(row(page, "period:D")).toContainText("바꿈");
  await row(page, "period:D").getByRole("button", { name: "일에서 D 빼기" }).click();
  await expect(row(page, "period:D").getByRole("button", { name: "일에서 D 빼기" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await page.keyboard.press("BracketRight");
  await page.keyboard.press("KeyD");
  await expect(periodButton(page, "일")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("KeyQ");
  await expect(periodButton(page, "일")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => savedHotkeys(scenario)).toEqual({ "period:D": ["KeyQ"] });
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("BracketRight");
  await page.keyboard.press("KeyQ");
  await expect(periodButton(page, "일")).toHaveAttribute("aria-pressed", "true");
});

test("다른 동작이 쓰는 키는 옮길지 묻고, 옮기면 원래 동작에서 빠지고 취소하면 그대로다", async ({ page }) => {
  await openChart(page);
  await openHotkeys(page);
  await record(page, "period:D", "일", "Q");
  await record(page, "period:W", "주", "Q");
  await expect(row(page, "period:W")).toContainText('Q는 "일"에 쓰고 있습니다');
  await row(page, "period:W").getByRole("button", { name: "취소" }).click();
  await expect(row(page, "period:W").getByRole("button", { name: "주에서 Q 빼기" })).toHaveCount(0);
  await expect(row(page, "period:D").getByRole("button", { name: "일에서 Q 빼기" })).toBeVisible();
  await record(page, "period:W", "주", "Q");
  await row(page, "period:W").getByRole("button", { name: "옮기기" }).click();
  await expect(row(page, "period:W").getByRole("button", { name: "주에서 Q 빼기" })).toBeVisible();
  await expect(row(page, "period:D").getByRole("button", { name: "일에서 Q 빼기" })).toHaveCount(0);
});

test("바꿀 수 없는 키는 막고 이유를 보이며 차트가 가로채는 키도 막는다", async ({ page }) => {
  await openChart(page);
  await openHotkeys(page);
  await record(page, "period:D", "일", "Control+W");
  await expect(row(page, "period:D")).toContainText("바꿀 수 없는 키입니다");
  await expect(row(page, "period:D").getByRole("button", { name: "일에서 Ctrl+W 빼기" })).toHaveCount(0);
  await record(page, "search", "종목 검색", "Control+Alt+Z");
  await expect(row(page, "search")).toContainText("Ctrl+Alt+Z는 바꿀 수 없는 키입니다");
  await expect(row(page, "search")).toContainText("되돌리기");
  await expect(row(page, "search").getByRole("button", { name: /Ctrl\+Alt\+Z 빼기/ })).toHaveCount(0);
});

test("키를 기다리는 중의 Esc는 기록만 취소하고 창은 열어 둔다", async ({ page }) => {
  await openChart(page);
  await openHotkeys(page);
  await row(page, "period:D").getByRole("button", { name: "일에 키 더하기" }).click();
  await expect(row(page, "period:D")).toContainText("키를 누르세요");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeVisible();
  await expect(row(page, "period:D")).not.toContainText("키를 누르세요");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("숫자패드 + 키도 글자로 보인다", async ({ page }) => {
  await openChart(page);
  await openHotkeys(page);
  await record(page, "period:10m", "10분", "NumpadAdd");
  await expect(row(page, "period:10m").getByRole("button", { name: "10분에서 Num + 빼기" })).toBeVisible();
});

test("찾기 칸은 키 글자로 거른다", async ({ page }) => {
  await openChart(page);
  await openHotkeys(page);
  await panel(page).getByRole("searchbox", { name: "단축키 찾기" }).fill("Alt+S");
  await expect(panel(page).locator("li[data-action]")).toHaveCount(1);
  await expect(row(page, "snapshotDownload")).toBeVisible();
  await expect(panel(page).getByRole("region", { name: "바꿀 수 없는 키" })).toHaveCount(0);
});

test("모두 기본값으로는 한 번 더 묻고 되돌리면 저장된 바꿈이 비워진다", async ({ page, scenario }) => {
  await openChart(page);
  await openHotkeys(page);
  await record(page, "period:D", "일", "Q");
  await expect.poll(() => savedHotkeys(scenario)).toEqual({ "period:D": ["KeyD", "KeyQ"] });
  await panel(page).getByRole("button", { name: "모두 기본값으로" }).click();
  await expect(panel(page)).toContainText("바꾼 키를 모두 되돌릴까요?");
  await panel(page).getByRole("button", { name: "취소" }).click();
  await expect(row(page, "period:D").getByRole("button", { name: "일에서 Q 빼기" })).toBeVisible();
  await panel(page).getByRole("button", { name: "모두 기본값으로" }).click();
  await panel(page).getByRole("button", { name: "되돌리기" }).click();
  await expect(row(page, "period:D").getByRole("button", { name: "일에서 D 빼기" })).toBeVisible();
  await expect.poll(() => savedHotkeys(scenario)).toEqual({});
});

test.describe("360px 폭", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("단축키 내용에 가로 스크롤이 없다", async ({ page }) => {
    await openChart(page);
    await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
    await dialog(page).getByRole("tab", { name: "단축키" }).click();
    await expect(panel(page)).toBeVisible();
    const scroller = panel(page).locator("div.overflow-y-auto");
    expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  });
});
