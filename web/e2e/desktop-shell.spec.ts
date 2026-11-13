import { financialPage, financialUpdatePage } from "./financial-update-helpers";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { cell, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

const tabs = (page: import("@playwright/test").Page) => page.getByRole("tablist", { name: "오른쪽 패널" });

test("한 줄 셸과 탭은 작은 창에서도 넘치지 않고 휴대폰 경로를 유지한다", async ({ page }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "지표·비교 입력창", exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "입력창 닫기", exact: true }).first().click();
  await page.getByRole("button", { name: "차트 설정", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "지표·비교 입력창", exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "입력창 닫기", exact: true }).first().click();
  await mkdir(path.resolve("../target/ux-screens"), { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 1280, height: 600 }]) {
    await page.setViewportSize(size);
    await expect(page.getByRole("toolbar", { name: "차트 도구 막대" })).toHaveJSProperty("offsetHeight", 48);
    expect((await page.getByRole("toolbar", { name: "차트 도구 막대" }).boundingBox())?.y).toBe(12);
    await expect(page.locator("footer").last()).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("navigation", { name: "드로잉 도구" })).toBeInViewport({ ratio: 1 });
    for (const name of ["관심종목", "스크리너", "개체"]) {
      await tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) }).click();
      await expect.poll(() => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight])).toEqual([0, 0]);
      await expect(cell(page)).toBeVisible();
      await page.getByRole("button", { name: "넓게 보기", exact: true }).click();
      await expect.poll(() => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight])).toEqual([0, 0]);
      await page.getByRole("button", { name: name === "스크리너" ? "오른쪽 탭으로" : "넓게 보기", exact: true }).click();
    }
    await tabs(page).getByRole("tab", { name: "관심종목", exact: true }).click();
    await page.screenshot({ path: path.resolve(`../target/ux-screens/shell-${size.width}x${size.height}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tabs(page)).toBeHidden();
  await expect(page.getByRole("toolbar", { name: "차트 도구 막대" })).toBeHidden();
  await expect(cell(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight])).toEqual([0, 0]);
  await page.screenshot({ path: path.resolve("../target/ux-screens/shell-390x844.png") });
});

test("오른쪽 탭·숨김·너비는 저장되고 새로고침 뒤 복원된다", async ({ page, scenario }) => {
  await page.goto("/");
  await tabs(page).getByRole("tab", { name: /^스크리너/ }).click();
  await page.getByRole("button", { name: "넓게 보기", exact: true }).click();
  const width = await page.getByRole("tabpanel").evaluate((el) => el.getBoundingClientRect().width);
  await expect.poll(async () => scenario.documents.uiState()).toMatchObject({ rightPanel: "screener", rightPanelWidth: "wide" });
  await page.reload();
  await expect(tabs(page).getByRole("tab", { name: /^스크리너/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "오른쪽 탭으로", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.getByRole("tabpanel").evaluate((el) => el.getBoundingClientRect().width)).toBe(width);
  await page.getByRole("button", { name: "탭 숨기기", exact: true }).click();
  await expect(tabs(page)).toBeHidden();
  await expect.poll(async () => scenario.documents.uiState().watchCollapsed).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "패널 펴기", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "패널 펴기", exact: true }).click();
  await expect(tabs(page).getByRole("tab", { name: /^스크리너/ })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.getByRole("tabpanel").evaluate((el) => el.getBoundingClientRect().width)).toBe(width);
  await tabs(page).getByRole("tab", { name: /^스크리너/ }).press("ArrowRight");
  await expect(tabs(page).getByRole("tab", { name: "개체", exact: true })).toBeFocused();
  await expect.poll(async () => scenario.documents.uiState().rightPanel).toBe("objects");
  await page.reload();
  await expect(tabs(page).getByRole("tab", { name: "개체", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("상태 막대는 연결·저장·서버 시계와 공유 재무 조회의 진행·실패를 표시한다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const financial = financialPage();
  financial.status = "collecting";
  financial.progress = { completed: 3, total: 10, failed: 1, pending: 6 };
  const update = financialUpdatePage();
  update.status = "collecting";
  await page.route("**/api/financial-update", (route) => route.fulfill({ json: update }));
  await page.route("**/financials?period=Y", (route) => route.fulfill({ json: financial }));
  const settings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: [{ id: "revenue", spec: { kind: "revenue" }, panel: "revenue", visible: true, style: { colors: ["ind-1"], width: 1 } }], panels: [{ id: "revenue", stretch: 0.3 }] };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0]!, symbol: "005930", venue: "combined", period: "Y", chartSettings: settings }] });
  await page.goto("/");
  const footer = page.locator("footer").last();
  await expect(footer).toContainText(/실시간 연결됨|장 닫힘: 체결 없음/);
  await expect(footer.getByLabel("장 상태와 서버 시계")).toHaveText(/장(중| 마감) · \d{2}:\d{2}:\d{2}/);
  await expect(footer.getByLabel("재무 수집 상태")).toContainText("3/10");
  await expect(footer.getByLabel("재무 수집 상태")).toContainText("실패 1");
  await expect(footer.getByRole("progressbar", { name: "재무 수집 진행률" })).toHaveAttribute("value", "3");
  await tabs(page).getByRole("tab", { name: "개체", exact: true }).click();
  await expect(footer).toContainText("자동 저장됨");
  financial.status = "partial_failure";
  update.status = "partial_failure";
  await expect(footer.getByLabel("재무 수집 상태")).toContainText("일부 조회 실패");
  await page.reload();
  await expect(footer.getByLabel("재무 수집 상태")).toContainText("일부 조회 실패");
  await expect(footer.getByLabel("재무 수집 상태")).toContainText("실패 1");
});
