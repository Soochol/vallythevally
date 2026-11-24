import type { Page } from "@playwright/test";
import type { Quote } from "../src/api/generated/Quote";
import type { Venue } from "../src/api/generated/Venue";
import { type Scenario, cell, expect, test, pickDesktopVenue, pollSaved } from "./harness";

test.use({ clockStart: "20261109100000" });

const WATCHED = ["005930", "005935", "IDX:001"];
const PRICES: Record<Venue, Record<string, number>> = {
  combined: { "005930": 71_000, "005935": 52_000, "IDX:001": 2_600 },
  krx: { "005930": 70_500, "005935": 51_500, "IDX:001": 2_600 },
  nxt: { "005930": 70_800, "005935": 52_000, "IDX:001": 2_600 },
};

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const main = (page: Page, code: string) => row(page, code).locator("[data-main]");
const fallbackBadge = (page: Page, code: string) => row(page, code).getByText("통합", { exact: true });

function quoteIn(requested: Venue, symbol: string): Quote {
  if (!(symbol in PRICES.combined)) throw new Error(`시세를 정하지 않은 종목: ${symbol}`);
  const index = symbol.startsWith("IDX:");
  const unavailableOnNxt = requested === "nxt" && symbol === "005935";
  const venue: Venue | null = index ? null : unavailableOnNxt ? "combined" : requested;
  const price = PRICES[unavailableOnNxt ? "combined" : requested][symbol]!;
  return { symbol, price, change: 100, changeRate: 1.5, volume: 1_000, t: 1794186000, source: "polled", venue };
}

type QuoteRequest = { symbols: string[]; venue: string | null };

function serveQuotes(scenario: Scenario) {
  const requests: QuoteRequest[] = [];
  const gates = new Map<Venue, { release(): void; promise: Promise<void> }>();
  scenario.on("/api/quotes", async (request) => {
    const url = new URL(request.url());
    const venue = url.searchParams.get("venue") as Venue;
    requests.push({ symbols: url.searchParams.get("symbols")!.split(","), venue });
    await gates.get(venue)?.promise;
    const known = url.searchParams.get("symbols")!.split(",").filter((symbol) => symbol in PRICES.combined);
    return { body: known.map((symbol) => quoteIn(venue, symbol)) };
  });
  return {
    requests,
    holdUntilReleased(venue: Venue) {
      let release = () => {};
      const promise = new Promise<void>((resolve) => { release = resolve; });
      gates.set(venue, { release, promise });
      return release;
    },
  };
}

function seedWatchlist(scenario: Scenario, symbols: string[] = WATCHED) {
  const current = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: current.lists.map((list, i) => (i === 0 ? { ...list, symbols } : list)), revision: current.revision + 1 });
}

const watchMessages = (scenario: Scenario) => scenario.live.messages.flatMap((m) => (m.type === "watch" ? [{ symbols: m.symbols, venue: m.venue }] : []));
const lastWatch = (scenario: Scenario) => watchMessages(scenario).at(-1);

test("앱 전체 거래소가 통합이면 시세 조회와 watch가 통합으로 나가고 줄에 표시가 없다", async ({ page, scenario }) => {
  seedWatchlist(scenario);
  const served = serveQuotes(scenario);
  await page.goto("/");
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 71,000 /);
  await expect(main(page, "005935")).toHaveAccessibleName(/^삼성전자우 52,000 /);
  expect(served.requests).toEqual([{ symbols: WATCHED, venue: "combined" }]);
  await pollSaved(() => lastWatch(scenario)).toEqual({ symbols: WATCHED, venue: "combined" });
  for (const code of WATCHED) await expect(fallbackBadge(page, code)).toHaveCount(0);
});

test("위 막대에서 KRX를 누르면 시세 조회와 watch가 KRX로 다시 나가고 새 값을 받기 전에는 값 없음이다", async ({ page, scenario }) => {
  seedWatchlist(scenario);
  const served = serveQuotes(scenario);
  await page.goto("/");
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 71,000 /);

  const release = served.holdUntilReleased("krx");
  await pickDesktopVenue(page, "KRX");
  await pollSaved(() => served.requests.at(-1)).toEqual({ symbols: WATCHED, venue: "krx" });
  await pollSaved(() => lastWatch(scenario)).toEqual({ symbols: WATCHED, venue: "krx" });
  await expect(main(page, "005930")).toHaveAccessibleName("삼성전자");
  await expect(row(page, "005930")).not.toContainText("71,000");
  await expect(row(page, "005930").getByText("—")).not.toHaveCount(0);

  release();
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 70,500 /);
  await expect(main(page, "005935")).toHaveAccessibleName(/^삼성전자우 51,500 /);
  for (const code of WATCHED) await expect(fallbackBadge(page, code)).toHaveCount(0);
});

test("KRX인 동안 실시간으로 온 시세가 줄에 반영되고 옛 거래소의 실시간 시세는 반영되지 않는다", async ({ page, scenario }) => {
  seedWatchlist(scenario);
  serveQuotes(scenario);
  await page.goto("/");
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 71,000 /);
  await pickDesktopVenue(page, "KRX");
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 70,500 /);

  scenario.live.emit({ type: "quotes", venue: "krx", quotes: [{ ...quoteIn("krx", "005930"), price: 70_700, source: "realtime" }] });
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 70,700 /);
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [{ ...quoteIn("combined", "005930"), price: 71_900, source: "realtime" }] });
  scenario.live.emit({ type: "quotes", venue: "krx", quotes: [{ ...quoteIn("krx", "005930"), price: 70_710, source: "realtime" }] });
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 70,710 /);
});

test("NXT를 누르면 NXT 불가 종목의 관심종목 줄에도 통합 글자가 없다", async ({ page, scenario }) => {
  seedWatchlist(scenario);
  const served = serveQuotes(scenario);
  await page.goto("/");
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 71,000 /);

  await pickDesktopVenue(page, "NXT");
  await pollSaved(() => served.requests.at(-1)).toEqual({ symbols: WATCHED, venue: "nxt" });
  await pollSaved(() => lastWatch(scenario)).toEqual({ symbols: WATCHED, venue: "nxt" });
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 70,800 /);
  await expect(main(page, "005935")).toHaveAccessibleName(/^삼성전자우 52,000 /);
  for (const code of WATCHED) {
    await expect(row(page, code)).not.toContainText("통합");
    await expect(main(page, code)).not.toHaveAccessibleName(/통합/);
  }
});

test("새로고침하면 저장된 앱 전체 거래소로 시세를 묻는다", async ({ page, scenario }) => {
  seedWatchlist(scenario);
  const served = serveQuotes(scenario);
  await page.goto("/");
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 71,000 /);
  await pickDesktopVenue(page, "KRX");
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 70,500 /);
  await pollSaved(() => scenario.documents.uiState().venue).toBe("krx");

  served.requests.length = 0;
  await page.reload();
  await expect(main(page, "005930")).toHaveAccessibleName(/^삼성전자 70,500 /);
  expect(served.requests).toEqual([{ symbols: WATCHED, venue: "krx" }]);
  await pollSaved(() => lastWatch(scenario)).toEqual({ symbols: WATCHED, venue: "krx" });
});

test("종목 검색을 열면 시세를 앱 전체 거래소로 묻고, 거래소를 바꾸면 같은 결과도 다시 묻는다", async ({ page, scenario }) => {
  const served = serveQuotes(scenario);
  const askedVenues = () => served.requests.filter((r) => r.symbols.includes("005930")).map((r) => r.venue);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  const samsungPrice = () => dialog.getByRole("option").filter({ hasText: "005930" }).getByLabel("현재가");

  await page.keyboard.press("/");
  await dialog.getByRole("combobox").fill("ㅅㅅ");
  await expect(samsungPrice()).toHaveText("71,000");
  expect(askedVenues()).toEqual(["combined"]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await pickDesktopVenue(page, "KRX");
  await pollSaved(() => scenario.documents.uiState().venue).toBe("krx");
  await page.keyboard.press("/");
  await dialog.getByRole("combobox").fill("ㅅㅅ");
  await expect(samsungPrice()).toHaveText("70,500");
  expect(askedVenues()).toEqual(["combined", "krx"]);
});
