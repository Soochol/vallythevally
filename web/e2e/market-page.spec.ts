import type { Page } from "@playwright/test";
import { anyMarketOverviewCall, indexCardWithoutBreadth, marketOverviewBaseline, marketOverviewCalls, SECTOR_NAMES, serveMarketRankings } from "./fixtures/market-data";
import { CONNECTED_KIWOOM } from "./fixtures/scenario";
import { cell, expect, test } from "./harness";

const main = (page: Page) => page.getByRole("main", { name: "시장 종합", exact: true });
const card = (page: Page, name: string) => main(page).getByRole("region", { name });
const ROUTES = ["index", "sectors", "flow", "flow/intraday", "turnover", "streaks"] as const;

test("시장을 코스닥으로 바꾸면 모든 칸이 코스닥 요청으로 다시 받고 주소에 남는다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  await page.goto("/market");
  await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
  for (const route of ROUTES) expect(marketOverviewCalls(scenario, route, "kosdaq")).toBe(0);

  await page.getByRole("group", { name: "시장" }).getByRole("button", { name: "코스닥" }).click();
  await expect(page).toHaveURL(/market=kosdaq/);
  await expect(card(page, "지수·폭").getByText("코스닥", { exact: true })).toBeVisible();
  await expect(card(page, "업종 지도").getByRole("button", { name: new RegExp(`^${SECTOR_NAMES.kosdaq[0]}`) })).toBeVisible();
  for (const route of ROUTES) await expect.poll(() => marketOverviewCalls(scenario, route, "kosdaq")).toBeGreaterThan(0);
  await expect(card(page, "종목").getByRole("button", { name: "에코프로" })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/market=kosdaq/);
  await expect(page.getByRole("group", { name: "시장" }).getByRole("button", { name: "코스닥" })).toHaveAttribute("aria-pressed", "true");
});

test("지수 종목 수가 없으면 '-'로 보이고 막대는 그리지 않는다", async ({ page, scenario }) => {
  scenario.reply((url) => url.pathname === "/api/market-overview/index", { body: indexCardWithoutBreadth("kospi") });
  await page.goto("/market");
  const index = card(page, "지수·폭");
  await expect(index.getByText("코스피", { exact: true })).toBeVisible();
  await expect(index.getByText("상승 -")).toBeVisible();
  await expect(index.getByText("보합 -")).toBeVisible();
  await expect(index.getByText("하락 -")).toBeVisible();
  await expect(index.locator('[data-cell="limit"] dd')).toHaveText("상한 - · 하한 -");
  await expect(index.locator(".mk-breadth-bar")).toHaveCount(0);
});

test("기간을 바꾸면 기간 인자가 달린 칸만 그 기간으로 다시 받는다", async ({ page, scenario }) => {
  await page.goto("/market");
  await page.getByRole("group", { name: "기간" }).getByRole("button", { name: "60일" }).click();
  await expect(page).toHaveURL(/period=60/);
  await expect.poll(() => scenario.requests.some((r) => /flow\?market=kospi&period=60/.test(r.url()))).toBe(true);
  await expect.poll(() => scenario.requests.some((r) => /turnover\?market=kospi&period=60/.test(r.url()))).toBe(true);
});

test("누가 사고 파나 칸에 네 주체의 막대와 누적선이 있다", async ({ page }) => {
  await page.goto("/market");
  const flow = card(page, "누가 사고 파나");
  const bars = flow.getByRole("list", { name: "주체별 순매수 막대" });
  for (const subject of ["individual", "foreign", "institution", "program"]) {
    await expect(bars.locator(`[data-subject="${subject}"]`)).toBeVisible();
    await expect(flow.locator(`.mk-line[data-subject="${subject}"]`)).toHaveAttribute("d", /^M/);
  }
  await expect(bars.locator('[data-subject="individual"]')).toHaveAttribute("data-eok", "0");
  await expect(bars.locator('[data-subject="foreign"]')).toHaveAttribute("data-eok", "400");
  await expect(bars.locator('[data-subject="program"]')).toHaveAttribute("data-eok", "130");
  await expect(flow.getByRole("img", { name: "장중 누적선" })).toBeVisible();
});

test("업종 칸을 누르면 그 업종의 주체별 수급이 보인다", async ({ page }) => {
  await page.goto("/market");
  const [sector] = SECTOR_NAMES.kospi;
  await card(page, "업종 지도").getByRole("button", { name: new RegExp(`^${sector}`) }).click();
  const detail = card(page, "업종 지도").getByRole("region", { name: `${sector} 주체별 수급` });
  await expect(detail).toBeVisible();
  await expect(detail.locator('[data-subject="foreignEok"]')).toContainText("+1,500억");
  await expect(detail.locator('[data-subject="individualEok"]')).toContainText("−700억");
});

test("종목 탭 행을 누르면 연동 색 차트에 그 종목이 열린다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  await page.goto("/market");
  const stocks = card(page, "종목");
  await stocks.getByRole("tab", { name: "상승" }).click();
  await stocks.getByRole("button", { name: "SK하이닉스" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스/);
});

test("연속 탭은 순매수·순매도 연속 종목을 보이고 행을 누르면 차트로 보낸다", async ({ page }) => {
  await page.goto("/market");
  const stocks = card(page, "종목");
  await stocks.getByRole("tab", { name: "외국인 연속" }).click();
  await expect(stocks.getByRole("region", { name: "순매수 연속" })).toContainText("삼성물산");
  await expect(stocks.getByRole("region", { name: "순매도 연속" })).toContainText("LG화학");
  await stocks.getByRole("tab", { name: "기관 연속" }).click();
  await expect(stocks.getByRole("region", { name: "순매수 연속" })).toContainText("SK하이닉스");
});

test("한 경로가 오류로 답하면 그 칸만 오류이고 나머지 칸은 보인다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  scenario.on((url) => url.pathname === "/api/market-overview/turnover", () => ({ status: 503, body: { error: { code: "kiwoom_unavailable", message: "키움이 응답하지 않습니다", reason: null, retryAt: null, manualActionRequired: false } } }));
  await page.goto("/market");
  await expect(card(page, "거래대금 추이").getByRole("alert")).toContainText("키움이 응답하지 않습니다");
  await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
  await expect(card(page, "누가 사고 파나").locator('[data-subject="foreign"]').first()).toBeVisible();
  await expect(card(page, "업종 지도").getByRole("button").first()).toBeVisible();
  await expect(card(page, "종목").getByRole("button", { name: "삼성전자" })).toBeVisible();
  await expect(main(page).getByRole("alert")).toHaveCount(1);
});

test("키움 연결 전이면 요청 없이 연결 안내를 보이고 연결되면 칸을 받는다", async ({ page, scenario }) => {
  scenario.live.kiwoomLink = { ...CONNECTED_KIWOOM, state: "disconnected", message: "키움에 연결하지 않았습니다" };
  await page.goto("/market");
  await expect(main(page).getByText("키움 연결 전입니다")).toBeVisible();
  await expect(card(page, "지수·폭")).toHaveCount(0);
  expect(anyMarketOverviewCall(scenario)).toBe(false);
  scenario.live.link(CONNECTED_KIWOOM);
  await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
});

const rgba = (page: Page, colors: string[]) =>
  page.evaluate((list) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    return list.map((value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
  }, colors);

const luminance = ([r, g, b]: number[]): number => {
  const [lr, lg, lb] = [r!, g!, b!].map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
};

const contrast = (foreground: number[], background: number[]): number => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
};

const cssVar = (page: Page, name: string) => page.evaluate((key) => getComputedStyle(document.documentElement).getPropertyValue(key).trim(), name);

const rightEdgeOfText = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().right;
  });

test.describe("1440×900 격자", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("같은 줄의 수급 카드와 업종 지도 카드는 아래 끝이 같다", async ({ page }) => {
    await page.goto("/market");
    const flow = card(page, "누가 사고 파나");
    const sector = card(page, "업종 지도");
    await expect(flow.getByRole("img", { name: "장중 누적선" })).toBeVisible();
    await expect(sector.getByRole("button").first()).toBeVisible();
    const [flowBox, sectorBox] = [await flow.boundingBox(), await sector.boundingBox()];
    expect(flowBox!.y + flowBox!.height).toBeCloseTo(sectorBox!.y + sectorBox!.height, 0);
    const [turnoverBox, stocksBox] = [await card(page, "거래대금 추이").boundingBox(), await card(page, "종목").boundingBox()];
    expect(turnoverBox!.y + turnoverBox!.height).toBeCloseTo(stocksBox!.y + stocksBox!.height, 0);
  });

  test("업종 지도의 글자 타일은 대비가 4.5:1 이상이고 색 범례가 보인다", async ({ page }) => {
    await page.goto("/market");
    const sector = card(page, "업종 지도");
    await expect(sector.getByRole("img", { name: /색 범례/ })).toBeVisible();
    const tiles = sector.locator('.mk-tile:not([data-label="none"])');
    await expect.poll(() => tiles.count()).toBeGreaterThan(0);
    const colors = await tiles.evaluateAll((nodes) => nodes.map((node) => [getComputedStyle(node).color, getComputedStyle(node).backgroundColor, getComputedStyle(node).opacity]));
    const parsed = await rgba(page, colors.flatMap(([ink, fill]) => [ink!, fill!]));
    colors.forEach(([, , opacity], index) => {
      expect(opacity).toBe("1");
      expect(contrast(parsed[index * 2]!, parsed[index * 2 + 1]!)).toBeGreaterThanOrEqual(4.5);
    });
  });

  test("수급 범례는 선과 같은 색의 표시가 있고 개인 선은 상승색이 아니다", async ({ page }) => {
    await page.goto("/market");
    const flow = card(page, "누가 사고 파나");
    const legend = flow.getByRole("list", { name: "누적선 범례" });
    await expect(legend.locator("li")).toHaveCount(4);
    for (const subject of ["individual", "foreign", "institution", "program"]) {
      const stroke = await flow.locator(`.mk-line[data-subject="${subject}"]`).evaluate((node) => getComputedStyle(node).stroke);
      const swatch = await legend.locator(`li[data-subject="${subject}"] .mk-swatch`).evaluate((node) => getComputedStyle(node).borderTopColor);
      const [a, b] = await rgba(page, [stroke, swatch]);
      expect(a).toEqual(b);
    }
    const individual = await flow.locator('.mk-line[data-subject="individual"]').evaluate((node) => getComputedStyle(node).stroke);
    const [line, up] = await rgba(page, [individual, await cssVar(page, "--up")]);
    expect(line).not.toEqual(up);
    await expect(flow.getByRole("list", { name: "선 끝 값" }).locator("li")).toHaveCount(4);
  });

  test("수급 선 위에 포인터를 올리면 세로선과 네 값이 뜬다", async ({ page }) => {
    await page.goto("/market");
    const pointer = card(page, "누가 사고 파나").getByTestId("flow-pointer");
    await expect(pointer).toBeVisible();
    const box = (await pointer.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const tip = pointer.getByRole("tooltip");
    await expect(tip).toBeVisible();
    for (const label of ["개인", "외국인", "기관", "프로그램"]) await expect(tip).toContainText(label);
  });

  test("거래대금 막대는 오늘만 강조색이고 평균선 문구가 보인다", async ({ page }) => {
    await page.goto("/market");
    const turnover = card(page, "거래대금 추이");
    await expect(turnover.getByText(/20일 평균/)).toBeVisible();
    await expect(turnover.locator('li[data-today="true"]')).toHaveCount(1);
    const fills = await turnover.locator(".mk-turnover i").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
    const [accent, ...parsed] = await rgba(page, [await cssVar(page, "--accent"), ...fills]);
    expect(parsed.filter((color) => color.join() === accent!.join())).toHaveLength(1);
    expect(fills.at(-1)).not.toBe(fills[0]);
  });

  test("종목 표의 현재가 머리와 값은 오른쪽 끝이 같고 거래대금은 부호가 없다", async ({ page, scenario }) => {
    serveMarketRankings(scenario);
    await page.goto("/market");
    const stocks = card(page, "종목");
    await expect(stocks.getByRole("button", { name: "삼성전자" })).toBeVisible();
    const head = await rightEdgeOfText(page, ".mk-table thead th:nth-child(3)");
    const value = await rightEdgeOfText(page, ".mk-table tbody tr:first-child td:nth-child(3)");
    expect(value).toBeCloseTo(head, 0);
    const trade = await stocks.locator(".mk-table tbody td:nth-child(5)").allTextContents();
    expect(trade.length).toBeGreaterThan(0);
    for (const text of trade) expect(text.startsWith("+")).toBe(false);
  });

  test("줄의 숫자 쪽을 눌러도 연동 색 차트가 그 종목을 연다", async ({ page, scenario }) => {
    serveMarketRankings(scenario);
    await page.goto("/market");
    await card(page, "종목").locator('.mk-table tr[data-code="028260"] td:nth-child(3)').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성물산/);
  });

  test("카드 요청이 실패하면 오류 글자는 위험색이고 다시 시도에 테두리가 있다", async ({ page, scenario }) => {
    scenario.on((url) => url.pathname === "/api/market-overview/turnover", () => ({ status: 503, body: { error: { code: "kiwoom_unavailable", message: "키움이 응답하지 않습니다", reason: null, retryAt: null, manualActionRequired: false } } }));
    await page.goto("/market");
    const alert = card(page, "거래대금 추이").getByRole("alert");
    await expect(alert).toContainText("키움이 응답하지 않습니다");
    const ink = await alert.evaluate((node) => getComputedStyle(node).color);
    const [shown, danger] = await rgba(page, [ink, await cssVar(page, "--danger")]);
    expect(shown).toEqual(danger);
    const retry = alert.getByRole("button", { name: "다시 시도" });
    expect(await retry.evaluate((node) => getComputedStyle(node).borderTopWidth)).not.toBe("0px");
  });

  test("응답을 붙잡았다 풀어도 아래 카드의 y가 변하지 않는다", async ({ page, scenario }) => {
    serveMarketRankings(scenario);
    const routes = ["index", "sectors", "flow", "flow/intraday"].map((route) => ({ route, held: scenario.hold((url) => url.pathname === `/api/market-overview/${route}`) }));
    await page.goto("/market");
    await Promise.all(routes.map((entry) => entry.held.received));
    const top = async () => [(await card(page, "거래대금 추이").boundingBox())!.y, (await card(page, "종목").boundingBox())!.y];
    await expect(card(page, "종목").getByRole("table")).toBeVisible();
    const waiting = await top();
    for (const { route, held } of routes) held.reply(marketOverviewBaseline(new URL(`http://host/api/market-overview/${route}?market=kospi&period=20`), "GET")!);
    await expect(card(page, "누가 사고 파나").getByRole("img", { name: "장중 누적선" })).toBeVisible();
    await expect(card(page, "업종 지도").getByRole("button").first()).toBeVisible();
    await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
    expect(await top()).toEqual(waiting);
  });

  test("지수·폭 카드는 지수를 크게 포인트와 등락률로 보이고 VKOSPI를 칸으로 둔다", async ({ page }) => {
    await page.goto("/market");
    const index = card(page, "지수·폭");
    const size = await index.locator(".mk-big").first().evaluate((node) => getComputedStyle(node).fontSize);
    expect(size).toBe("28px");
    await expect(index.locator('[data-cell="level"]')).toContainText("(+0.85%)");
    await expect(index.locator('[data-cell="limit"] dd')).toHaveText("상한 3 · 하한 1");
    await expect(index.locator('[data-cell="vkospi"]')).toContainText("18.40");
    await page.getByRole("group", { name: "시장" }).getByRole("button", { name: "코스닥" }).click();
    await expect(index.getByText("코스닥", { exact: true })).toBeVisible();
    await expect(index.locator('[data-cell="vkospi"]')).toHaveCount(0);
  });

  test("종목 탭은 화살표 키로 옮기고 업종 칸은 다시 누르면 풀린다", async ({ page }) => {
    await page.goto("/market");
    const stocks = card(page, "종목");
    await stocks.getByRole("tab", { name: "거래대금" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(stocks.getByRole("tab", { name: "상승" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(stocks.getByRole("tab", { name: "기관 연속" })).toHaveAttribute("aria-selected", "true");
    const [sector] = SECTOR_NAMES.kospi;
    const tile = card(page, "업종 지도").getByRole("button", { name: new RegExp(`^${sector}`) });
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "false");
  });
});
