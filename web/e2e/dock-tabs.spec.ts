import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { cell, DEFAULT_LAYOUT_ID, expect, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1280, height: 860 } });

const CLOSE_TOUCH = 24;
const settings = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const groups = (page: Page) => page.locator("[data-dock-group]");
const groupWith = (page: Page, name: string) => groups(page).filter({ has: page.getByRole("tab", { name: new RegExp(`^${name}`) }) });
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const tabGroupOf = (target: Locator) => target.locator("xpath=..");
const sideways = (page: Page) => page.getByRole("separator", { name: "좌우 창 경계" });

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 없는 요소의 자리를 찾았습니다");
  return box;
}

function unlinkedCharts(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const charts: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: settings },
    { id: "cell-1", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: settings },
  ];
  scenario.documents.saveLayout({ ...layout, windows: [...charts, ...layout.windows.filter((window) => window.kind !== "chart")], placement: {}, revision: layout.revision + 1 });
}

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

const luminanceOf = (target: Locator) => target.evaluate((element) => {
  const parse = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number);
  const [r = 0, g = 0, b = 0, a = 1] = parse(getComputedStyle(element).backgroundColor);
  const [br = 0, bg = 0, bb = 0] = parse(getComputedStyle(element.closest(".dock-group")!).backgroundColor);
  const channel = (value: number) => { const unit = value / 255; return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; };
  const mixed = [r, g, b].map((value, index) => value * a + [br, bg, bb][index]! * (1 - a));
  return 0.2126 * channel(mixed[0]!) + 0.7152 * channel(mixed[1]!) + 0.0722 * channel(mixed[2]!);
});

test("고른 탭의 배경이 포인터를 올린 다른 탭의 배경보다 밝다", async ({ page }) => {
  await open(page);
  const group = groupWith(page, "스크리너");
  const other = tabGroupOf(group.getByRole("tab", { selected: false }).first());
  const selected = group.locator(".dock-tab-group[data-selected]");
  await other.hover();
  expect(await luminanceOf(selected)).toBeGreaterThan(await luminanceOf(other));
  expect(await luminanceOf(other)).toBeGreaterThan(await luminanceOf(group.locator(".dock-tab-viewport")));
});

test("탭이 넘쳐도 ＋ 버튼이 보이고 탭 목록에서 숨은 탭을 고르면 그 탭이 보인다", async ({ page }) => {
  await open(page);
  const group = groupWith(page, "스크리너");
  const add = group.getByRole("button", { name: "이 묶음에 창 더하기" });
  for (let n = 0; n < 7; n += 1) {
    await add.click();
    await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^차트/ }).click();
  }
  const tabs = group.getByRole("tab");
  const count = await tabs.count();
  expect(count).toBeGreaterThan(7);
  const list = group.getByRole("button", { name: `탭 ${count}개` });
  await expect(list).toBeVisible();
  const strip = await boxOf(group.locator(".dock-tabs"));
  const plus = await boxOf(add);
  expect(plus.x).toBeGreaterThanOrEqual(strip.x);
  expect(plus.x + plus.width).toBeLessThanOrEqual(strip.x + strip.width);
  await list.click();
  await page.getByRole("menu", { name: "탭 목록" }).getByRole("menuitemradio").first().click();
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  const viewport = await boxOf(group.locator(".dock-tab-viewport"));
  const first = await boxOf(tabs.first());
  expect(first.x).toBeGreaterThanOrEqual(viewport.x - 1);
  expect(first.x + first.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
});

test("끈 연동 점은 포인터를 올리거나 키보드 초점이 갈 때만 보인다", async ({ page, scenario }) => {
  unlinkedCharts(scenario);
  await open(page);
  const target = tab(page, "삼성전자").first();
  const dot = target.locator("+ .link-dot");
  await expect(dot).toHaveAttribute("aria-label", "연동 색: 끔");
  await page.mouse.move(2, 2);
  await expect(dot).toHaveCSS("opacity", "0");
  await target.hover();
  await expect(dot).toHaveCSS("opacity", "1");
  await page.mouse.move(2, 2);
  await expect(dot).toHaveCSS("opacity", "0");
  await target.press("Shift+Tab");
  await target.focus();
  await expect(dot).toHaveCSS("opacity", "1");
});

test("탭을 끄는 동안 이름표가 포인터를 따라오고 놓으면 사라진다", async ({ page }) => {
  await open(page);
  const source = tab(page, "스크리너");
  const from = await boxOf(source);
  const ghost = page.locator("[data-dock-ghost]");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await expect(ghost).toHaveCount(0);
  await page.mouse.move(from.x + 200, from.y + 120, { steps: 6 });
  await expect(ghost).toBeVisible();
  await expect(ghost).toContainText("스크리너");
  await expect(tabGroupOf(source)).toHaveCSS("opacity", "0.4");
  const near = await boxOf(ghost);
  expect(Math.abs(near.x - (from.x + 200))).toBeLessThan(40);
  expect(Math.abs(near.y - (from.y + 120))).toBeLessThan(40);
  await page.mouse.move(from.x + 320, from.y + 160, { steps: 6 });
  const moved = await boxOf(ghost);
  expect(moved.x - near.x).toBeCloseTo(120, 0);
  expect(moved.y - near.y).toBeCloseTo(40, 0);
  expect(await ghost.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);
  await expect(tabGroupOf(source)).toHaveCSS("opacity", "1");
});

test("경계를 끄는 동안 크기 풍선은 흐림 없는 불투명 면이다", async ({ page }) => {
  await open(page);
  const handle = await boxOf(sideways(page).first());
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2, { steps: 6 });
  const balloon = page.locator("[data-dock-balloon]");
  await expect(balloon).toBeVisible();
  await expect(balloon).toHaveCSS("backdrop-filter", "none");
  await expect(balloon).toHaveCSS("border-top-width", "1px");
  await page.mouse.up();
});

test("닫기 버튼의 닿는 면은 24px 이상이다", async ({ page }) => {
  await open(page);
  const close = groupWith(page, "스크리너").getByRole("button", { name: /닫기$/ }).first();
  const touch = await close.evaluate((element) => {
    const pseudo = getComputedStyle(element, "::before");
    return { width: parseFloat(pseudo.width), height: parseFloat(pseudo.height) };
  });
  expect(touch.width).toBeGreaterThanOrEqual(CLOSE_TOUCH);
  expect(touch.height).toBeGreaterThanOrEqual(CLOSE_TOUCH);
  const box = await boxOf(close);
  const reach = CLOSE_TOUCH / 2 - 0.5;
  const points = [{ x: box.x - reach + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + reach + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2, y: box.y - reach + box.height / 2 }, { x: box.x + box.width / 2, y: box.y + reach + box.height / 2 }];
  for (const point of points) expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".dock-tab-close") !== null, point)).toBe(true);
});

test("떠 있는 창을 포인터로 조작한 뒤에는 초점 고리가 남지 않고 머리는 올린 면이다", async ({ page }) => {
  await open(page);
  await tab(page, "스크리너").click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "띄우기", exact: true }).click();
  const header = page.locator("[data-dock-float] [data-window-header]");
  await expect(header).toBeVisible();
  const box = await boxOf(header);
  await page.mouse.click(box.x + 40, box.y + box.height / 2);
  await expect(header).toBeFocused();
  expect(await header.evaluate((element) => element.matches(":focus-visible"))).toBe(false);
  await expect(header).toHaveCSS("background-color", await page.locator(".dock-tab-group[data-selected]").first().evaluate((element) => getComputedStyle(element).backgroundColor));
  await expect(header.getByRole("button", { name: /붙이기$/ })).toHaveAttribute("title", "붙이기");
});
