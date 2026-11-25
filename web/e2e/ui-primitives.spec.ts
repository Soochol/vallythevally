import type { Locator, Page } from "@playwright/test";
import { cell, expect, SEARCH_BUTTON_TITLE, test } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });

const RAISED = "rgb(35, 43, 35)";
const ACCENT = "rgb(199, 243, 107)";
const STATUS_BAR_HEIGHT = 28;
const TOAST_GAP = 12;

const topbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const layoutTrigger = (page: Page) => topbar(page).getByRole("button", { name: /^레이아웃:/ });
const layoutMenu = (page: Page) => page.getByRole("menu", { name: "레이아웃", exact: true });
const closeButton = (page: Page, name: string) => page.getByRole("button", { name: `${name} 닫기`, exact: true });
const toasts = (page: Page) => page.locator(".ui-toast");
const windowTab = (page: Page, name: string) => page.locator("[data-dock-group] .dock-tabs").getByRole("tab", { name: new RegExp(`^${name}`) });

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("레이아웃 지우기 확인창의 위험 단추는 .btn-danger이고 처음 초점은 취소다", async ({ page }) => {
  await open(page);
  await layoutTrigger(page).click();
  await layoutMenu(page).getByRole("menuitem", { name: "새 이름으로 저장…", exact: true }).click();
  const naming = page.getByRole("dialog", { name: "새 이름으로 저장", exact: true });
  await naming.getByRole("textbox", { name: "레이아웃 이름" }).fill("복기");
  await naming.getByRole("button", { name: "저장", exact: true }).click();
  await expect(layoutTrigger(page)).toHaveAccessibleName("레이아웃: 복기");

  await layoutTrigger(page).click();
  await layoutMenu(page).getByRole("menuitem", { name: "지우기", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "복기 레이아웃을 지웁니다" });
  const danger = confirm.getByRole("button", { name: "레이아웃 지우기", exact: true });
  const cancel = confirm.getByRole("button", { name: "취소", exact: true });
  await expect(danger).toHaveClass(/\bbtn-danger\b/);
  await expect(cancel).toHaveClass(/\bbtn\b/);
  await expect(cancel).toBeFocused();
  await expect(danger).toHaveCSS("height", "30px");
  await expect(cancel).toHaveCSS("height", "30px");
  await expect(confirm).toHaveCSS("backdrop-filter", "none");
  await cancel.click();
  await expect(confirm).toHaveCount(0);
});

test("창을 닫으면 알림이 아래 가운데에 뜨고 닫기 버튼이 있으며 되돌리기가 동작한다", async ({ page }) => {
  await open(page);
  await closeButton(page, "스크리너").click();
  await expect(windowTab(page, "스크리너")).toHaveCount(0);
  const toast = toasts(page).filter({ hasText: "스크리너 창을 닫았습니다" });
  await expect(toast).toBeVisible();
  const box = await boxOf(toast);
  const viewport = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height - (viewport.height - STATUS_BAR_HEIGHT - TOAST_GAP))).toBeLessThanOrEqual(1);
  await expect(toast.getByRole("button", { name: "알림 닫기", exact: true })).toBeVisible();
  await toast.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(windowTab(page, "스크리너")).toHaveCount(1);
  await expect(toast).toHaveCount(0);
});

test("알림 둘이 함께 떠도 서로 덮지 않고 닫기 버튼은 그 알림만 닫는다", async ({ page }) => {
  await open(page);
  await closeButton(page, "스크리너").click();
  await closeButton(page, "관심종목").click();
  const first = toasts(page).filter({ hasText: "스크리너 창을 닫았습니다" });
  const second = toasts(page).filter({ hasText: "관심종목 창을 닫았습니다" });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  const [a, b] = [await boxOf(first), await boxOf(second)];
  expect(a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  await expect(toasts(page)).toHaveCount(2);
  await first.getByRole("button", { name: "알림 닫기", exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
});

test("찾기 창의 결과 없음은 가운데 정렬 상태 판이고 버튼에 테두리가 있다", async ({ page }) => {
  await open(page);
  await topbar(page).getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색", exact: true });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("zzzzzzzz");
  const state = dialog.locator(".ui-state").filter({ hasText: "맞는 항목이 없습니다" });
  await expect(state).toBeVisible();
  await expect(state).toHaveCSS("text-align", "center");
  await expect(state).toHaveCSS("align-items", "center");
  await expect(state.locator(".ui-state-title")).toHaveCSS("font-size", "14px");
  await expect(state.locator(".ui-state-title")).toHaveCSS("font-weight", "600");
  const button = state.getByRole("button", { name: "입력 지우기", exact: true });
  await expect(button).toHaveCSS("border-top-width", "1px");
  await expect(button).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  const stateBox = await boxOf(state);
  const buttonBox = await boxOf(button);
  expect(Math.abs(buttonBox.x + buttonBox.width / 2 - (stateBox.x + stateBox.width / 2))).toBeLessThanOrEqual(1);
});

test("비활성 주요 버튼은 활성과 다른 면을 칠하고 불투명도로 흐리게 하지 않는다", async ({ page }) => {
  await open(page);
  await topbar(page).getByRole("button", { name: "비교", exact: true }).click();
  const inspector = page.getByRole("region", { name: "지표", exact: true });
  const primary = inspector.locator(".btn-primary");
  await expect(primary).toBeDisabled();
  await expect(primary).toHaveCSS("background-color", RAISED);
  await expect(primary).toHaveCSS("opacity", "1");
  await inspector.getByRole("searchbox", { name: "지표·비교 찾기" }).fill("000660");
  await inspector.getByRole("list", { name: "비교 후보" }).getByRole("button", { name: /000660/ }).click();
  await expect(primary).toBeEnabled();
  await expect(primary).toHaveCSS("background-color", ACCENT);
});

test("위 막대는 흐림 없이 불투명하게 그려진다", async ({ page }) => {
  await open(page);
  await expect(topbar(page)).toHaveClass(/\bui-island\b/);
  await expect(topbar(page)).toHaveCSS("backdrop-filter", "none");
  await expect(topbar(page)).toHaveCSS("background-color", "rgb(27, 33, 27)");
});

test("알림이 떠 있는 채 대화상자 안에서 뜬 알림도 가림막 위에 놓이고 되돌리기를 누를 수 있다", async ({ page }) => {
  await open(page);
  await closeButton(page, "스크리너").click();
  await expect(toasts(page).filter({ hasText: "스크리너 창을 닫았습니다" })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "관심종목에 넣을 종목 검색" });
  const input = dialog.getByRole("combobox", { name: "종목 검색" });
  await page.getByRole("complementary", { name: "관심종목" }).getByRole("button", { name: "관심종목에 넣기" }).click();
  await expect(input).toBeFocused();
  await input.fill("000660");
  await expect(dialog.getByRole("option").filter({ hasText: "000660" })).toHaveAttribute("aria-disabled", "false");
  await input.press("Enter");
  const added = toasts(page).filter({ hasText: "에 넣었습니다" });
  await expect(added).toBeVisible();
  const box = await boxOf(added);
  const top = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest(".ui-toast") !== null, [box.x + box.width / 2, box.y + box.height / 2]);
  expect(top).toBe(true);
  await added.getByRole("button", { name: "되돌리기" }).click();
  await expect(dialog).toBeVisible();
});

test("새 알림이 떠도 이미 떠 있는 알림은 다시 만들어지지 않아 남은 시간을 잃지 않는다", async ({ page, scenario }) => {
  await page.clock.install({ time: scenario.now });
  await open(page);
  await closeButton(page, "스크리너").click();
  const first = toasts(page).filter({ hasText: "스크리너 창을 닫았습니다" });
  await expect(first).toBeVisible();
  await first.evaluate((node) => node.setAttribute("data-mark", "kept"));
  await page.clock.fastForward(1000);
  await closeButton(page, "관심종목").evaluate((button) => (button as HTMLElement).click());
  await expect(toasts(page).filter({ hasText: "관심종목 창을 닫았습니다" })).toBeVisible();
  await expect(first).toHaveAttribute("data-mark", "kept");
  await page.clock.fastForward(5500);
  await expect(first).toHaveCount(0);
});
