import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Venue } from "../src/api/generated/Venue";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, SEARCH_BUTTON_TITLE, test, pickDesktopVenue, desktopVenueCombo, expectDesktopVenue } from "./harness";

const SETTINGS = { v: 2, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const LEGEND_OFF = { ...SETTINGS, showLegend: false };

type BarRequest = { symbol: string; venue: string | null; period: string; limit: string | null };

const chart = (id: string, symbol: string, venue: Venue | null, chartSettings: object = SETTINGS): LayoutWindow =>
  ({ id, link: null, kind: "chart", symbol, venue, period: "D", chartSettings });

function seedCharts(scenario: Scenario, charts: LayoutWindow[]) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  scenario.documents.saveLayout({ ...layout, windows: [...charts, ...layout.windows.filter((w) => w.kind !== "chart")], placement: {}, revision: layout.revision + 1 });
}

function recordBars(page: Page): BarRequest[] {
  const seen: BarRequest[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname !== "/api/bars") return;
    const q = url.searchParams;
    seen.push({ symbol: q.get("symbol")!, venue: q.get("venue"), period: q.get("period")!, limit: q.get("limit") });
  });
  return seen;
}

const lastRequest = (seen: BarRequest[], symbol: string) => seen.filter((r) => r.symbol === symbol).at(-1);
const venues = (page: Page) => page.getByRole("group", { name: "거래소", exact: true });
const venueButton = (page: Page, name: string) => venues(page).getByRole("button", { name, exact: true });
const topbarCombo = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("combobox", { name: "거래소", exact: true });
const fallbackBadge = (c: Locator) => c.getByText("통합", { exact: true });
const savedVenue = (scenario: Scenario) => scenario.documents.uiState().venue;

async function drawn(c: Locator, label: RegExp) {
  await expect(c).toHaveAttribute("aria-label", label);
  await expect(c).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => Number(await chartOf(c).getAttribute("data-bar-count"))).toBeGreaterThan(0);
}

test.describe("데스크톱", () => {
  test("위 막대에 거래소 콤보박스가 있고 범례에는 거래소 버튼이 없다", async ({ page, scenario }) => {
    seedCharts(scenario, [chart("cell-0", "005930", "combined"), chart("cell-1", "000660", "combined", LEGEND_OFF)]);
    await page.goto("/");
    await drawn(cell(page, 1), /^칸 1: 삼성전자 통합 일$/);
    await drawn(cell(page, 2), /^칸 2: SK하이닉스 통합 일$/);
    await expect(topbarCombo(page)).toBeVisible();
    await expect(topbarCombo(page)).toContainText("통합");
    await expect(desktopVenueCombo(page)).toHaveCount(1);
    await expect(venues(page)).toHaveCount(0);
    for (const n of [1, 2]) await expect(cell(page, n).getByRole("button", { name: /^(KRX|NXT|통합)/ })).toHaveCount(0);
  });

  test("펼친 메뉴에 머리와 세 항목과 설명이 보인다", async ({ page, scenario }) => {
    seedCharts(scenario, [chart("cell-0", "005930", "combined")]);
    await page.goto("/");
    await drawn(cell(page, 1), /^칸 1: 삼성전자 통합 일$/);
    await desktopVenueCombo(page).click();
    const menu = page.getByRole("menu", { name: "거래소", exact: true });
    await expect(menu).toContainText("거래소 · 모든 차트와 관심종목에 적용");
    await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
    await expect(menu.getByRole("menuitemradio", { name: /^통합/ })).toContainText("KRX와 NXT를 합친 시세");
    await expect(menu.getByRole("menuitemradio", { name: /^KRX/ })).toContainText("한국거래소 정규장 시세");
    await expect(menu.getByRole("menuitemradio", { name: /^NXT/ })).toContainText("넥스트레이드 시세 · 없는 종목은 통합");
    await expect(menu.getByRole("menuitemradio", { name: /^통합/ })).toHaveAttribute("aria-checked", "true");
  });

  test("콤보박스를 키보드로 열어 고르고 Esc로 닫는다", async ({ page, scenario }) => {
    seedCharts(scenario, [chart("cell-0", "005930", "combined")]);
    await page.goto("/");
    await drawn(cell(page, 1), /^칸 1: 삼성전자 통합 일$/);
    await desktopVenueCombo(page).focus();
    await page.keyboard.press("ArrowDown");
    const menu = page.getByRole("menu", { name: "거래소", exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitemradio", { name: /^KRX/ }).focus();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expectDesktopVenue(page, "KRX");
    await drawn(cell(page, 1), /^칸 1: 삼성전자 KRX 일$/);
    await expect.poll(() => savedVenue(scenario)).toBe("krx");
    await expect(desktopVenueCombo(page)).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expectDesktopVenue(page, "KRX");
    await expect(desktopVenueCombo(page)).toBeFocused();
  });

  test("위 막대에서 KRX를 누르면 모든 칸이 KRX 봉을 요청하고 KRX로 구독하며 비교 종목도 KRX다", async ({ page, scenario }) => {
    seedCharts(scenario, [chart("cell-0", "005930", "combined", { ...SETTINGS, compare: ["000810"] }), chart("cell-1", "000660", "combined")]);
    const seen = recordBars(page);
    await page.goto("/");
    await drawn(cell(page, 1), /^칸 1: 삼성전자 통합 일$/);
    await drawn(cell(page, 2), /^칸 2: SK하이닉스 통합 일$/);

    await pickDesktopVenue(page, "KRX");
    await expectDesktopVenue(page, "KRX");
    await drawn(cell(page, 1), /^칸 1: 삼성전자 KRX 일$/);
    await drawn(cell(page, 2), /^칸 2: SK하이닉스 KRX 일$/);
    await expect.poll(() => [lastRequest(seen, "005930")?.venue, lastRequest(seen, "000660")?.venue, lastRequest(seen, "000810")?.venue]).toEqual(["krx", "krx", "krx"]);
    await expect.poll(() => scenario.live.subscriptions().filter((s) => s.venue === "krx").map((s) => s.symbol).sort()).toEqual(["000660", "000810", "005930"]);
    await expect.poll(() => savedVenue(scenario)).toBe("krx");
  });

  test("새로고침해도 KRX가 남고 다른 레이아웃으로 바꿔도 KRX다", async ({ page, scenario }) => {
    await page.goto("/?symbol=005930");
    await drawn(cell(page), /^칸 1: 삼성전자 통합 일$/);
    await pickDesktopVenue(page, "KRX");
    await expect.poll(() => savedVenue(scenario)).toBe("krx");
    await page.reload();
    await drawn(cell(page), /^칸 1: 삼성전자 KRX 일$/);
    await expectDesktopVenue(page, "KRX");

    await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: /^레이아웃:/ }).click();
    await page.getByRole("menu", { name: "레이아웃", exact: true }).getByRole("menuitem", { name: "새 이름으로 저장…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 이름으로 저장", exact: true });
    await dialog.getByRole("textbox", { name: "레이아웃 이름" }).fill("둘째");
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "레이아웃: 둘째" })).toBeVisible();
    await expectDesktopVenue(page, "KRX");
    await drawn(cell(page), /^칸 1: 삼성전자 KRX 일$/);
  });

  test("NXT를 누르면 NXT 종목은 NXT 봉을, 거래되지 않는 종목은 통합 봉을 요청하고 뒤의 칸에만 통합 표시가 보인다", async ({ page, scenario }) => {
    seedCharts(scenario, [chart("cell-0", "005930", "combined"), chart("cell-1", "005935", "combined"), chart("cell-2", "IDX:001", null)]);
    const seen = recordBars(page);
    await page.goto("/");
    await drawn(cell(page, 1), /^칸 1: 삼성전자 통합 일$/);

    await pickDesktopVenue(page, "NXT");
    await expectDesktopVenue(page, "NXT");
    await drawn(cell(page, 1), /^칸 1: 삼성전자 NXT 일$/);
    await drawn(cell(page, 2), /^칸 2: 삼성전자우 통합 일$/);
    await drawn(cell(page, 3), /^칸 3: 코스피 일$/);
    await expect.poll(() => [lastRequest(seen, "005930")?.venue, lastRequest(seen, "005935")?.venue, lastRequest(seen, "IDX:001")?.venue]).toEqual(["nxt", "combined", null]);
    await expect(fallbackBadge(cell(page, 2))).toHaveAttribute("title", "NXT에서 거래되지 않는 종목이라 통합 시세로 보입니다");
    await expect(fallbackBadge(cell(page, 1))).toHaveCount(0);
    await expect(fallbackBadge(cell(page, 3))).toHaveCount(0);
    await expectDesktopVenue(page, "NXT");
    await expect(cell(page, 2).getByRole("button", { name: /^(KRX|NXT|통합)/ })).toHaveCount(0);
  });

  test("범례를 끈 칸에서도 NXT 불가 종목은 봉 값 줄 앞에 통합 표시가 있다", async ({ page, scenario }) => {
    seedCharts(scenario, [chart("cell-0", "005935", "combined", LEGEND_OFF)]);
    await page.goto("/");
    await drawn(cell(page), /^칸 1: 삼성전자우 통합 일$/);
    await pickDesktopVenue(page, "NXT");
    await drawn(cell(page), /^칸 1: 삼성전자우 통합 일$/);
    const badge = fallbackBadge(cell(page));
    await expect(badge).toBeVisible();
    const ohlc = cell(page).locator("[data-ohlc]");
    const [b, o] = await Promise.all([badge.boundingBox(), ohlc.boundingBox()]);
    expect(b!.x + b!.width).toBeLessThanOrEqual(o!.x + 1);
  });

  test("옛 레이아웃의 칸마다 거래소는 읽지 않고, 저장하면 주식 창은 combined 지수 창은 null이다", async ({ page, scenario }) => {
    seedCharts(scenario, [chart("cell-0", "005930", "krx"), chart("cell-1", "000660", "nxt"), chart("cell-2", "IDX:001", null)]);
    await page.goto("/");
    await drawn(cell(page, 1), /^칸 1: 삼성전자 통합 일$/);
    await drawn(cell(page, 2), /^칸 2: SK하이닉스 통합 일$/);
    await expectDesktopVenue(page, "통합");
    await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "주", exact: true }).click();
    await expect.poll(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.filter((w) => w.kind === "chart").map((w) => w.kind === "chart" ? w.venue : undefined)).toEqual(["combined", "combined", null]);
  });

  test("주소의 venue는 위 막대를 바꾸고, venue가 없으면 그대로 둔다", async ({ page, scenario }) => {
    await page.goto("/?symbol=005930&venue=krx");
    await drawn(cell(page), /^칸 1: 삼성전자 KRX 일$/);
    await expectDesktopVenue(page, "KRX");
    await expect.poll(() => savedVenue(scenario)).toBe("krx");
    await page.goto("/?symbol=000660");
    await drawn(cell(page), /^칸 1: SK하이닉스 KRX 일$/);
    await expectDesktopVenue(page, "KRX");
    await page.goto("/?symbol=005930&venue=nope");
    await drawn(cell(page), /^칸 1: 삼성전자 KRX 일$/);
  });

  test("종목 검색의 작은 차트가 앱 전체 거래소로 요청한다", async ({ page }) => {
    await page.goto("/?symbol=005930&venue=krx");
    await drawn(cell(page), /^칸 1: 삼성전자 KRX 일$/);
    const seen = recordBars(page);
    await page.getByTitle(SEARCH_BUTTON_TITLE).click();
    const dialog = page.getByRole("dialog", { name: "종목 검색" });
    await dialog.getByRole("combobox").fill("ㅅㅅㅈㅈ");
    const option = dialog.getByRole("option").filter({ hasText: "005930" });
    await option.hover();
    await expect(dialog.getByRole("img", { name: "삼성전자 60일 추세" })).toBeVisible();
    expect(seen.filter((r) => r.limit === "60").map((r) => [r.symbol, r.venue])).toContainEqual(["005930", "krx"]);
  });
});

test.describe("휴대폰 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("머리의 거래소 묶음이 같은 앱 전체 설정을 바꾼다", async ({ page, scenario }) => {
    const seen = recordBars(page);
    await page.goto("/?symbol=005930");
    await drawn(cell(page), /^칸 1: 삼성전자 통합 일$/);
    await expect(page.getByRole("toolbar", { name: "차트 도구 막대" })).toBeHidden();
    await venueButton(page, "KRX").click();
    await drawn(cell(page), /^칸 1: 삼성전자 KRX 일$/);
    expect(lastRequest(seen, "005930")?.venue).toBe("krx");
    await expect.poll(() => savedVenue(scenario)).toBe("krx");
  });
});
