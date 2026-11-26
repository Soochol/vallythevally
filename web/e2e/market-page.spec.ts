import type { Page } from "@playwright/test";
import type { RankingPage } from "../src/api/generated/RankingPage";
import type { RankingRow } from "../src/api/generated/RankingRow";
import { anyMarketOverviewCall, indexCardWithoutBreadth, marketOverviewBaseline, marketOverviewCalls, marketOverviewScopedCalls, RANKING_ROWS, SECTOR_NAMES, serveMarketRankings } from "./fixtures/market-data";
import { KIS_MARKET_SOURCE, KIWOOM_MARKET_SOURCE } from "./fixtures/market-source";
import { CONNECTED_KIWOOM } from "./fixtures/scenario";
import { cell, expect, fixedWait, type Scenario, test } from "./harness";

const main = (page: Page) => page.getByRole("main", { name: "시장 종합", exact: true });
const card = (page: Page, name: string) => main(page).getByRole("region", { name });
const PER_MARKET_ROUTES = ["sectors", "flow", "flow/intraday", "turnover", "streaks"] as const;

test("첫 화면은 코스피·코스닥을 동시에 보이고 카드를 눌러 범위를 좁히고 다시 누르면 전체로 돌아간다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  await page.goto("/market");
  const index = card(page, "지수·폭");
  await expect(index.getByText("코스피", { exact: true })).toBeVisible();
  await expect(index.getByText("코스닥", { exact: true })).toBeVisible();
  await expect(index.getByTestId("market-diagnosis")).toContainText("디커플링 · 코스피 쏠림");
  await expect(index.getByRole("img", { name: /시장 체력 5축 요약/ })).toBeVisible();
  await expect(main(page).getByRole("group", { name: "시장 범위" }).getByRole("button", { name: "전체" })).toHaveAttribute("aria-pressed", "true");
  for (const route of PER_MARKET_ROUTES) expect(marketOverviewCalls(scenario, route, "kosdaq")).toBe(0);

  const kosdaqTile = index.locator('.mk-market-card[data-market="kosdaq"]');
  await kosdaqTile.click();
  await expect(page).toHaveURL(/scope=kosdaq/);
  await expect(kosdaqTile).toHaveAttribute("aria-pressed", "true");
  await expect(main(page).getByRole("group", { name: "시장 범위" }).getByRole("button", { name: "코스닥" })).toHaveAttribute("aria-pressed", "true");
  await expect(card(page, "업종 지도").getByRole("button", { name: new RegExp(`^${SECTOR_NAMES.kosdaq[0]}`) })).toBeVisible();
  for (const route of PER_MARKET_ROUTES) await expect.poll(() => marketOverviewCalls(scenario, route, "kosdaq")).toBeGreaterThan(0);
  await expect.poll(() => marketOverviewScopedCalls(scenario, "derived", "kosdaq")).toBeGreaterThan(0);
  await expect(card(page, "종목").getByRole("button", { name: "에코프로" })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/scope=kosdaq/);
  await expect(main(page).getByRole("group", { name: "시장 범위" }).getByRole("button", { name: "코스닥" })).toHaveAttribute("aria-pressed", "true");
  await expect(card(page, "지수·폭").locator('.mk-market-card[data-market="kosdaq"]')).toHaveAttribute("aria-pressed", "true");

  await card(page, "지수·폭").locator('.mk-market-card[data-market="kosdaq"]').click();
  await expect(page).toHaveURL(/scope=all/);
  await expect(main(page).getByRole("group", { name: "시장 범위" }).getByRole("button", { name: "전체" })).toHaveAttribute("aria-pressed", "true");
});

test("지수 종목 수가 없으면 '-'로 보이고 막대는 그리지 않는다", async ({ page, scenario }) => {
  scenario.reply((url) => url.pathname === "/api/market-overview/index", { body: indexCardWithoutBreadth("kospi") });
  await page.goto("/market");
  const index = card(page, "지수·폭");
  const kospiTile = index.locator('.mk-market-card[data-market="kospi"]');
  await expect(kospiTile.getByText("코스피", { exact: true })).toBeVisible();
  await expect(kospiTile.getByText("상승 -")).toBeVisible();
  await expect(kospiTile.getByText("보합 -")).toBeVisible();
  await expect(kospiTile.getByText("하락 -")).toBeVisible();
  await expect(kospiTile.locator('[data-cell="limit"] .mk-metric-val')).toHaveText("상한 - · 하한 -");
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

test("업종 칸을 누르면 수급이 보이고 장중 키움 테마 전환과 주도 종목 차트 이동이 된다", async ({ page }) => {
  await page.goto("/market");
  const sectorCard = card(page, "업종 지도");
  const [sector] = SECTOR_NAMES.kospi;
  await sectorCard.getByRole("button", { name: new RegExp(`^${sector}`) }).click();
  const detail = sectorCard.getByRole("region", { name: `${sector} 주체별 수급` });
  await expect(detail).toBeVisible();
  await expect(detail.locator('[data-subject="foreignEok"]')).toContainText("+1,500억");
  await expect(detail.locator('[data-subject="individualEok"]')).toContainText("−700억");

  await sectorCard.getByRole("group", { name: "업종 보기" }).getByRole("button", { name: "장중 키움 테마" }).click();
  await expect(sectorCard.getByText("HBM·AI반도체")).toBeVisible();
  await expect(sectorCard.getByText("+3.45%")).toBeVisible();
  await sectorCard.getByRole("button", { name: "SK하이닉스" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스/);
});

test("시장 체력 X-Ray는 9구간 분포와 KRX·NXT 거래소 비중을 보인다", async ({ page }) => {
  await page.goto("/market");
  const xray = card(page, "시장 체력 X-Ray");
  await expect(xray.locator(".mk-hist-col")).toHaveCount(9);
  await xray.locator('.mk-hist-col[data-bucket="+0.5~+2%"] button').click();
  await expect(xray.getByTestId("histogram-readout")).toContainText("+0.5~+2%");
  await expect(xray.locator('.mk-venue-cell[data-venue="krx"]')).toContainText("82.1%");
  await expect(xray.locator('.mk-venue-cell[data-venue="nxt"]')).toContainText("17.9%");
});

test("지수 기여도와 시장 추세 체력은 파생 지표를 보이고 기여 종목을 누르면 차트로 보낸다", async ({ page }) => {
  await page.goto("/market");
  const attribution = card(page, "지수 기여도");
  await expect(attribution.getByTestId("attribution-concentration")).toContainText("64.5%");
  await expect(attribution.getByRole("region", { name: "상승 기여 상위" })).toContainText("삼성전자");
  await expect(attribution.getByRole("region", { name: "하락 기여 상위" })).toContainText("LG화학");

  const maThrust = card(page, "시장 추세 체력");
  for (const ma of ["ma5", "ma20", "ma60", "ma200"]) await expect(maThrust.locator(`[data-ma="${ma}"]`)).toBeVisible();
  await expect(maThrust.locator(".mk-ma-path")).toHaveAttribute("d", /^M/);

  await attribution.locator('.mk-attr-item[data-code="000660"] button').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스/);
});

test("로테이션 RRG는 4분면 SVG 궤적을 그리고 테마·업종 전환과 툴팁을 보인다", async ({ page }) => {
  await page.goto("/market");
  const rrg = card(page, "로테이션 RRG");
  await expect(rrg.locator(".mk-rrg-svg")).toBeVisible();
  await expect(rrg.locator(".mk-rrg-bg")).toHaveCount(4);
  await expect(rrg.locator(".mk-rrg-trail")).toHaveCount(4);
  await expect(rrg.locator(".mk-rrg-arrow")).toHaveCount(4);

  await rrg.locator('.mk-rrg-chip[data-code="304"]').click();
  const tip = rrg.getByTestId("rrg-tooltip");
  await expect(tip).toContainText("바이오 신약");
  await expect(tip).toContainText("개선 (Improving)");
  await expect(tip).toContainText("99.50");
  await expect(tip).toContainText("101.30");
  await expect(tip).toContainText("+1.42%");

  await rrg.getByRole("group", { name: "RRG 대상" }).getByRole("button", { name: "업종" }).click();
  await expect(rrg.locator('.mk-rrg-series[data-code="013"]')).toBeVisible();
  await expect(tip).toContainText("전기전자");
});

test("장중 세션 DNA는 6구간 타임라인과 진행 중 구간 강조, 거래소 비중을 보인다", async ({ page }) => {
  await page.goto("/market");
  const dna = card(page, "장중 세션 DNA");
  await expect(dna.locator(".mk-dna-window")).toHaveCount(6);
  for (const label of ["NXT 프리", "장초반", "본장", "마감", "NXT 전반", "NXT 후반"]) {
    await expect(dna.getByText(label, { exact: true })).toBeVisible();
  }
  const active = dna.locator('.mk-dna-window[data-window="krxMid"]');
  await expect(active).toHaveAttribute("data-active", "true");
  await expect(active.getByText("진행 중")).toBeVisible();
  await expect(dna.getByTestId("session-venue-split")).toContainText("82.1%");
  await expect(dna.getByTestId("session-venue-split")).toContainText("17.9%");
});

test("창구·호가 압력 카드는 매수 압력 막대와 상위 종목 차트 이동을 지원한다", async ({ page }) => {
  await page.goto("/market");
  const book = card(page, "창구·호가 압력");
  await expect(book.getByTestId("broker-pressure-bar")).toContainText("61.4%");
  await expect(book.getByRole("region", { name: "매수 압력 상위" })).toContainText("삼성전자");
  await expect(book.getByRole("region", { name: "매도 압력 상위" })).toContainText("LG화학");
  await expect(book.getByRole("region", { name: "외국인 순매수" })).toContainText("SK하이닉스");
  await expect(book.getByRole("region", { name: "프로그램 순매수" })).toContainText("삼성전자");

  await book.getByRole("region", { name: "외국인 순매수" }).locator('[data-code="028260"] button').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성물산/);
});

test("핵심 공시 레이더는 유형별 필터링과 공시 종목 차트 이동을 지원한다", async ({ page }) => {
  await page.goto("/market");
  const disc = card(page, "핵심 공시 레이더");
  await expect(disc.getByTestId("disclosure-total")).toContainText("총 4건");
  await expect(disc.locator(".mk-disc-item")).toHaveCount(4);

  const filters = disc.getByRole("group", { name: "공시 유형 필터" });
  await filters.getByRole("button", { name: /수주·계약/ }).click();
  await expect(disc.locator(".mk-disc-item")).toHaveCount(1);
  await expect(disc.locator(".mk-disc-item").first()).toContainText("SK하이닉스");
  await expect(disc.locator(".mk-disc-item").first()).toContainText("2026.11.09");

  await filters.getByRole("button", { name: /실적/ }).click();
  await expect(disc.locator(".mk-disc-item")).toHaveCount(1);
  await disc.locator('.mk-disc-item[data-code="196170"] button').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 알테오젠/);
});

test("프로 인텔리전스 경로가 503으로 실패해도 기존 시장 종합 칸들은 그대로 보인다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  scenario.on((url) => url.pathname === "/api/market-overview/pro", () => ({ status: 503, body: { error: { code: "not_prepared", message: "프로 지표 자료가 아직 준비되지 않았습니다", reason: null, retryAt: null, manualActionRequired: false } } }));
  await page.goto("/market");
  for (const title of ["로테이션 RRG", "장중 세션 DNA", "창구·호가 압력", "핵심 공시 레이더"]) {
    await expect(card(page, title).getByRole("alert")).toContainText("프로 지표 자료가 아직 준비되지 않았습니다");
  }
  await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
  await expect(card(page, "시장 체력 X-Ray").locator(".mk-hist-col")).toHaveCount(9);
  await expect(card(page, "지수 기여도").getByRole("region", { name: "상승 기여 상위" })).toContainText("삼성전자");
  await expect(card(page, "종목").getByRole("button", { name: "삼성전자" })).toBeVisible();
});

test("프로 인텔리전스 한 구역만 실패해도 나머지 프로 카드는 정상 표시된다", async ({ page, scenario }) => {
  const base = marketOverviewBaseline(new URL("http://host/api/market-overview/pro?scope=all"), "GET")!.body as Record<string, unknown>;
  scenario.reply((url) => url.pathname === "/api/market-overview/pro", {
    body: {
      ...base,
      brokerBook: { status: "failed", error: { code: "not_prepared", message: "호가 압력 자료가 비어 있습니다", reason: null, retryAt: null, manualActionRequired: false } },
    },
  });
  await page.goto("/market");
  await expect(card(page, "창구·호가 압력").getByRole("alert")).toContainText("호가 압력 자료가 비어 있습니다");
  await expect(card(page, "창구·호가 압력").locator('[data-kind="not-prepared"]')).toBeVisible();
  await expect(card(page, "창구·호가 압력").getByRole("button", { name: "다시 확인" })).toBeVisible();
  await expect(card(page, "로테이션 RRG").locator(".mk-rrg-trail")).toHaveCount(4);
  await expect(card(page, "장중 세션 DNA").locator(".mk-dna-window")).toHaveCount(6);
  await expect(card(page, "핵심 공시 레이더").locator(".mk-disc-item")).toHaveCount(4);
});

test("종목 탭 행과 VI 발동 탭 행을 누르면 연동 색 차트에 그 종목이 열린다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  await page.goto("/market");
  const stocks = card(page, "종목");
  await stocks.getByRole("tab", { name: "VI 발동" }).click();
  await expect(stocks.getByText("상승 VI").first()).toBeVisible();
  await expect(stocks.getByText("10:15:32")).toBeVisible();
  await expect(stocks.getByText("정적", { exact: true })).toBeVisible();
  await stocks.getByRole("button", { name: "에코프로" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 에코프로/);
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
  await expect(card(page, "업종 지도").locator(".mk-tile").first()).toBeVisible();
  await expect(card(page, "시장 체력 X-Ray").locator(".mk-hist-col")).toHaveCount(9);
  await expect(card(page, "종목").getByRole("button", { name: "삼성전자" })).toBeVisible();
  await expect(main(page).getByRole("alert")).toHaveCount(1);
});

test("파생 경로가 503으로 실패해도 기존 시장 종합 칸들은 그대로 보인다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  scenario.on((url) => url.pathname === "/api/market-overview/derived", () => ({ status: 503, body: { error: { code: "not_prepared", message: "파생 표본이 아직 준비되지 않았습니다", reason: null, retryAt: null, manualActionRequired: false } } }));
  await page.goto("/market");
  await expect(card(page, "시장 체력 X-Ray").getByRole("alert")).toContainText("파생 표본이 아직 준비되지 않았습니다");
  await expect(card(page, "지수 기여도").getByRole("alert")).toContainText("파생 표본이 아직 준비되지 않았습니다");
  await expect(card(page, "시장 추세 체력").getByRole("alert")).toContainText("파생 표본이 아직 준비되지 않았습니다");
  await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
  await expect(card(page, "누가 사고 파나").getByRole("img", { name: "장중 누적선" })).toBeVisible();
  await expect(card(page, "업종 지도").locator(".mk-tile").first()).toBeVisible();
  await expect(card(page, "거래대금 추이").locator(".mk-turnover li").first()).toBeVisible();
  await expect(card(page, "종목").getByRole("button", { name: "삼성전자" })).toBeVisible();
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

  test("같은 줄의 거래대금·종목, 기여도·추세 카드는 아래 끝이 같고 업종 지도·RRG는 전체 폭으로 크게 보인다", async ({ page }) => {
    await page.goto("/market");
    const index = card(page, "지수·폭");
    const flow = card(page, "누가 사고 파나");
    const sector = card(page, "업종 지도");
    const rrg = card(page, "로테이션 RRG");
    await expect(flow.getByRole("img", { name: "장중 누적선" })).toBeVisible();
    await expect(sector.locator(".mk-tile").first()).toBeVisible();
    await expect(rrg.locator(".mk-rrg-svg")).toBeVisible();
    const [indexBox, flowBox, sectorBox, rrgBox] = [
      await index.boundingBox(),
      await flow.boundingBox(),
      await sector.boundingBox(),
      await rrg.boundingBox(),
    ];
    expect(flowBox!.width).toBeCloseTo(indexBox!.width, 0);
    expect(sectorBox!.width).toBeCloseTo(indexBox!.width, 0);
    expect(rrgBox!.width).toBeCloseTo(indexBox!.width, 0);
    const mapBox = (await sector.locator(".mk-map").boundingBox())!;
    expect(mapBox.height).toBeGreaterThanOrEqual(440);
    const radarBox = (await index.locator(".mk-radar-svg").boundingBox())!;
    expect(radarBox.width).toBeGreaterThanOrEqual(200);
    await expect(index.locator(".mk-radar-vlabel")).toHaveCount(5);
    const rrgSvgBox = (await rrg.locator(".mk-rrg-svg").boundingBox())!;
    expect(rrgSvgBox.height).toBeGreaterThanOrEqual(440);
    const [turnoverBox, stocksBox] = [await card(page, "거래대금 추이").boundingBox(), await card(page, "종목").boundingBox()];
    expect(turnoverBox!.y + turnoverBox!.height).toBeCloseTo(stocksBox!.y + stocksBox!.height, 0);
    const [attrBox, maBox] = [await card(page, "지수 기여도").boundingBox(), await card(page, "시장 추세 체력").boundingBox()];
    expect(attrBox!.y + attrBox!.height).toBeCloseTo(maBox!.y + maBox!.height, 0);
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
    const kospiIndex = scenario.hold((url) => url.pathname === "/api/market-overview/index" && url.searchParams.get("market") === "kospi");
    const kosdaqIndex = scenario.hold((url) => url.pathname === "/api/market-overview/index" && url.searchParams.get("market") === "kosdaq");
    const routes = ["sectors", "flow", "flow/intraday"].map((route) => ({ route, held: scenario.hold((url) => url.pathname === `/api/market-overview/${route}`) }));
    await page.goto("/market");
    await Promise.all([kospiIndex.received, kosdaqIndex.received, ...routes.map((entry) => entry.held.received)]);
    const top = async () => [(await card(page, "거래대금 추이").boundingBox())!.y, (await card(page, "종목").boundingBox())!.y];
    await expect(card(page, "종목").getByRole("table")).toBeVisible();
    const waiting = await top();
    kospiIndex.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/index?market=kospi"), "GET")!);
    kosdaqIndex.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/index?market=kosdaq"), "GET")!);
    for (const { route, held } of routes) held.reply(marketOverviewBaseline(new URL(`http://host/api/market-overview/${route}?market=kospi&period=20`), "GET")!);
    await expect(card(page, "누가 사고 파나").getByRole("img", { name: "장중 누적선" })).toBeVisible();
    await expect(card(page, "업종 지도").locator(".mk-tile").first()).toBeVisible();
    await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
    expect(await top()).toEqual(waiting);
  });

  test("지수·폭 카드는 코스피·코스닥을 나란히 28px로 보이고 코스피에 VKOSPI를 둔다", async ({ page }) => {
    await page.goto("/market");
    const index = card(page, "지수·폭");
    const size = await index.locator(".mk-big").first().evaluate((node) => getComputedStyle(node).fontSize);
    expect(size).toBe("28px");
    const kospiTile = index.locator('.mk-market-card[data-market="kospi"]');
    const kosdaqTile = index.locator('.mk-market-card[data-market="kosdaq"]');
    await expect(kospiTile.locator('[data-cell="level"]')).toContainText("(+0.85%)");
    await expect(kospiTile.locator('[data-cell="limit"] .mk-metric-val')).toHaveText("상한 3 · 하한 1");
    await expect(kospiTile.locator('[data-cell="vkospi"]')).toContainText("18.40");
    await expect(kosdaqTile.locator('[data-cell="level"]')).toContainText("(−0.30%)");
    await expect(kosdaqTile.locator('[data-cell="vkospi"]')).toHaveCount(0);
  });

  test("종목 탭은 화살표 키로 옮기고 업종 칸은 다시 누르면 풀린다", async ({ page }) => {
    await page.goto("/market");
    const stocks = card(page, "종목");
    await stocks.getByRole("tab", { name: "거래대금" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(stocks.getByRole("tab", { name: "상승" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(stocks.getByRole("tab", { name: "VI 발동" })).toHaveAttribute("aria-selected", "true");
    const [sector] = SECTOR_NAMES.kospi;
    const tile = card(page, "업종 지도").getByRole("button", { name: new RegExp(`^${sector}`) });
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "false");
  });

  test("파생 응답이 늦게 도착해도 시장 체력 X-Ray와 아래 카드들의 y가 변하지 않는다", async ({ page, scenario }) => {
    serveMarketRankings(scenario);
    const derivedHold = scenario.hold((url) => url.pathname === "/api/market-overview/derived");
    await page.goto("/market");
    await derivedHold.received;
    await expect(card(page, "종목").getByRole("table")).toBeVisible();

    const snapshot = async () => ({
      xrayHeight: (await card(page, "시장 체력 X-Ray").boundingBox())!.height,
      turnoverY: (await card(page, "거래대금 추이").boundingBox())!.y,
      stocksY: (await card(page, "종목").boundingBox())!.y,
      attributionY: (await card(page, "지수 기여도").boundingBox())!.y,
      maThrustY: (await card(page, "시장 추세 체력").boundingBox())!.y,
    });

    const before = await snapshot();
    derivedHold.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/derived?scope=all"), "GET")!);
    await expect(card(page, "시장 체력 X-Ray").locator(".mk-hist-col")).toHaveCount(9);
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  test("업종 지도를 주도 종목이 많은 8개 장중 키움 테마로 전환해도 아래 카드의 y가 변하지 않는다", async ({ page, scenario }) => {
    const eightWrappedThemes = Array.from({ length: 8 }, (_, idx) => ({
      code: `30${idx}`,
      name: `긴이름테마 ${idx + 1}`,
      stockCount: 25,
      changeRate: 5.5 - idx * 0.6,
      periodReturn: 7.0 - idx * 0.5,
      rising: 18,
      falling: 5,
      leaders: ["삼성전자", "SK하이닉스", "삼성바이오로직스", "LG에너지솔루션", "HD현대중공업"],
    }));
    scenario.reply((url) => url.pathname === "/api/market-overview/themes", {
      body: { phase: "regular", receivedAt: 1_794_186_000, source: "kiwoom", themes: { status: "ok", value: eightWrappedThemes } },
    });
    await page.goto("/market");
    await expect(card(page, "업종 지도").locator(".mk-tile").first()).toBeVisible();
    const xrayBefore = (await card(page, "시장 체력 X-Ray").boundingBox())!.y;

    await card(page, "업종 지도").getByRole("group", { name: "업종 보기" }).getByRole("button", { name: "장중 키움 테마" }).click();
    await expect(card(page, "업종 지도").locator(".mk-theme-card")).toHaveCount(8);
    const xrayAfter = (await card(page, "시장 체력 X-Ray").boundingBox())!.y;
    expect(xrayAfter).toBe(xrayBefore);
  });

  test("프로 응답이 늦게 도착해도 2행 프로 카드의 y가 변하지 않는다", async ({ page, scenario }) => {
    const heldPro = scenario.hold((url) => url.pathname === "/api/market-overview/pro");
    await page.goto("/market");
    await heldPro.received;

    const book = card(page, "창구·호가 압력");
    const disc = card(page, "핵심 공시 레이더");
    await expect(book).toBeVisible();
    await expect(disc).toBeVisible();
    const beforeBookY = (await book.boundingBox())!.y;
    const beforeDiscY = (await disc.boundingBox())!.y;

    heldPro.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/pro?scope=all"), "GET")!);
    await expect(card(page, "로테이션 RRG").locator(".mk-rrg-trail")).toHaveCount(4);
    await expect(book.getByTestId("broker-pressure-bar")).toBeVisible();

    expect((await book.boundingBox())!.y).toBe(beforeBookY);
    expect((await disc.boundingBox())!.y).toBe(beforeDiscY);
  });
});

test("범위 전환 중 파생·VI·프로 응답이 대기 중이면 이전 범위 자료를 새 범위 헤더 아래에 띄우지 않는다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  await page.goto("/market");
  await expect(card(page, "시장 체력 X-Ray").locator('.mk-venue-cell[data-venue="krx"]')).toContainText("82.1%");
  await expect(card(page, "지수 기여도")).toContainText("삼성전자");
  await expect(card(page, "창구·호가 압력").getByRole("region", { name: "매수 압력 상위" })).toContainText("삼성전자");
  await expect(card(page, "핵심 공시 레이더").getByTestId("disclosure-total")).toContainText("총 4건");

  const stocks = card(page, "종목");
  await stocks.getByRole("tab", { name: "VI 발동" }).click();
  await expect(stocks.getByRole("button", { name: "SK하이닉스" })).toBeVisible();

  const kosdaqDerived = scenario.hold((url) => url.pathname === "/api/market-overview/derived" && url.searchParams.get("scope") === "kosdaq");
  const kosdaqVi = scenario.hold((url) => url.pathname === "/api/market-overview/vi" && url.searchParams.get("scope") === "kosdaq");
  const kosdaqPro = scenario.hold((url) => url.pathname === "/api/market-overview/pro" && url.searchParams.get("scope") === "kosdaq");

  await card(page, "지수·폭").locator('.mk-market-card[data-market="kosdaq"]').click();
  await Promise.all([kosdaqDerived.received, kosdaqVi.received, kosdaqPro.received]);

  await expect(card(page, "시장 체력 X-Ray").locator(".mk-card-note")).toContainText("코스닥 기준");
  await expect(card(page, "시장 체력 X-Ray")).not.toContainText("82.1%");
  await expect(card(page, "지수 기여도").locator(".mk-card-note")).not.toContainText("코스피 기준");
  await expect(card(page, "지수 기여도")).not.toContainText("삼성전자");
  await expect(stocks.locator('tr[data-code="000660"]')).toHaveCount(0);
  await expect(card(page, "창구·호가 압력").locator(".mk-card-note")).toContainText("코스닥 기준");
  await expect(card(page, "창구·호가 압력")).not.toContainText("삼성전자");
  await expect(card(page, "핵심 공시 레이더").locator(".mk-card-note")).toContainText("코스닥 기준");
  await expect(card(page, "핵심 공시 레이더").getByText("SK하이닉스")).toHaveCount(0);
  await expect(card(page, "핵심 공시 레이더").getByTestId("disclosure-total")).toHaveCount(0);

  kosdaqDerived.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/derived?scope=kosdaq"), "GET")!);
  kosdaqVi.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/vi?scope=kosdaq"), "GET")!);
  kosdaqPro.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/pro?scope=kosdaq"), "GET")!);

  await expect(card(page, "지수 기여도")).toContainText("알테오젠");
  await expect(stocks.getByRole("button", { name: "에코프로" })).toBeVisible();
  await expect(card(page, "창구·호가 압력").getByRole("region", { name: "매수 압력 상위" })).toContainText("알테오젠");
});

test("한투 단독 원천에서는 VI 발동과 장중 키움 테마가 요청 없이 미지원 안내를 보이고 실시간 전환 시 즉시 바뀐다", async ({ page, scenario }) => {
  scenario.live.marketSource = KIS_MARKET_SOURCE;
  serveMarketRankings(scenario);
  await page.goto("/market");

  const stocks = card(page, "종목");
  await stocks.getByRole("tab", { name: "VI 발동" }).click();
  await expect(stocks.getByTestId("feed-unavailable")).toBeVisible();
  expect(scenario.requests.some((r) => new URL(r.url()).pathname === "/api/market-overview/vi")).toBe(false);

  const sector = card(page, "업종 지도");
  await sector.getByRole("group", { name: "업종 보기" }).getByRole("button", { name: "장중 키움 테마" }).click();
  await expect(sector.getByTestId("feed-unavailable")).toBeVisible();
  expect(scenario.requests.some((r) => new URL(r.url()).pathname === "/api/market-overview/themes")).toBe(false);

  scenario.live.source(KIWOOM_MARKET_SOURCE);
  await expect(stocks.getByRole("button", { name: "SK하이닉스" })).toBeVisible();
  await expect(sector.getByText("HBM·AI반도체")).toBeVisible();

  scenario.live.source(KIS_MARKET_SOURCE);
  await expect(stocks.getByTestId("feed-unavailable")).toBeVisible();
  await expect(sector.getByTestId("feed-unavailable")).toBeVisible();
});

test("장중 키움 테마 주도 종목 검색 실패는 토스트로 알리고 동시 클릭 경합에서 이전 응답이 차트를 덮어쓰지 않는다", async ({ page, scenario }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  scenario.reply((url) => url.pathname === "/api/symbols" && url.searchParams.get("q") === "SK하이닉스", {
    status: 503,
    body: { error: { code: "internal", message: "종목 검색 실패", reason: null, retryAt: null, manualActionRequired: false } },
  });
  await page.goto("/market");
  const sector = card(page, "업종 지도");
  await sector.getByRole("group", { name: "업종 보기" }).getByRole("button", { name: "장중 키움 테마" }).click();
  await sector.getByRole("button", { name: "SK하이닉스" }).click();
  await expect(page.getByRole("status").filter({ hasText: "종목 정보를 찾지 못했습니다" })).toBeVisible();
  await expect(sector.getByRole("button", { name: "SK하이닉스" })).toBeEnabled();
  expect(pageErrors).toEqual([]);

  const firstLookup = scenario.hold((url) => url.pathname === "/api/symbols" && url.searchParams.get("q") === "SK하이닉스");
  await sector.getByRole("button", { name: "SK하이닉스" }).click();
  await firstLookup.received;
  await sector.getByRole("button", { name: "삼성전자" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성전자/);

  const settled = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/symbols" && new URL(res.url()).searchParams.get("q") === "SK하이닉스");
  firstLookup.reply({ body: [scenario.market.symbols.find((s) => s.code === "000660")!] });
  await settled;
  await fixedWait(page, 200, "지연된 첫 주도주 검색 응답이 도착한 뒤에도 차트 종목이 유지되는지 확인");
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성전자/);
});

test("시장 추세 체력 단일 시점 스파크라인은 보이는 경로와 점 마커를 함께 그린다", async ({ page, scenario }) => {
  const base = marketOverviewBaseline(new URL("http://host/api/market-overview/derived?scope=all"), "GET")!.body as Record<string, unknown>;
  const maThrust = (base.maThrust as { status: "ok"; value: Record<string, unknown> }).value;
  scenario.reply((url) => url.pathname === "/api/market-overview/derived", {
    body: {
      ...base,
      maThrust: { status: "ok", value: { ...maThrust, history20d: [{ date: "2026-11-09", above20Pct: 58.6 }] } },
    },
  });
  await page.goto("/market");
  const maCard = card(page, "시장 추세 체력");
  const dotEl = maCard.locator(".mk-ma-svg circle.mk-ma-dot");
  await expect(dotEl).toHaveCount(1);
  await expect(dotEl).toBeVisible();
  const dotBox = (await dotEl.boundingBox())!;
  expect(dotBox.width).toBeGreaterThan(0);
  expect(dotBox.height).toBeGreaterThan(0);
  const pathEl = maCard.locator(".mk-ma-path");
  const pathBox = (await pathEl.boundingBox())!;
  expect(pathBox.width + pathBox.height).toBeGreaterThan(0);
  const length = await pathEl.evaluate((el) => (el as SVGPathElement).getTotalLength());
  expect(length).toBeGreaterThan(0);
});

test("전체 범위에서 코스피 지수만 503으로 실패해도 코스닥이 살아 있으면 신선도가 실패 상태가 되지 않는다", async ({ page, scenario }) => {
  scenario.on(
    (url) => url.pathname === "/api/market-overview/index" && url.searchParams.get("market") === "kospi",
    () => ({ status: 503, body: { error: { code: "kiwoom_unavailable", message: "코스피 지연", reason: null, retryAt: null, manualActionRequired: false } } }),
  );
  await page.goto("/market");
  await expect(card(page, "지수·폭").getByText("코스닥", { exact: true })).toBeVisible();
  const freshness = page.getByLabel("자료 신선도");
  await expect(freshness).not.toHaveAttribute("data-tone", "failed");
  await expect(freshness).not.toContainText("받지 못함");
});

test("창구·호가 압력의 총 매수·매도 잔량이 모두 0이면 양쪽 압력이 0.0%로 표시된다", async ({ page, scenario }) => {
  const base = marketOverviewBaseline(new URL("http://host/api/market-overview/pro?scope=all"), "GET")!.body as Record<string, unknown>;
  const baseBook = (base.brokerBook as { value: Record<string, unknown> }).value;
  scenario.reply((url) => url.pathname === "/api/market-overview/pro", {
    body: {
      ...base,
      brokerBook: {
        status: "ok",
        value: {
          ...baseBook,
          totalBidRemaining: 0,
          totalAskRemaining: 0,
          buyPressurePct: 0,
          topBuyPressure: [],
          topSellPressure: [],
        },
      },
    },
  });
  await page.goto("/market");
  const bar = card(page, "창구·호가 압력").getByTestId("broker-pressure-bar");
  await expect(bar).toContainText("매수 압력 0.0%");
  await expect(bar).toContainText("매도 압력 0.0%");
  await expect(bar).not.toContainText("100.0%");
  await expect(bar.locator('.mk-book-bar i[data-side="up"]')).toHaveAttribute("style", /width:\s*0%/);
  await expect(bar.locator('.mk-book-bar i[data-side="down"]')).toHaveAttribute("style", /width:\s*0%/);
});

test("핵심 공시 레이더의 칩 카운트는 실제 필터 가능한 항목 수와 일치하고 전체 매칭 수가 더 크면 함께 안내한다", async ({ page, scenario }) => {
  const base = marketOverviewBaseline(new URL("http://host/api/market-overview/pro?scope=all"), "GET")!.body as Record<string, unknown>;
  const items = Array.from({ length: 30 }, (_, idx) => ({
    code: "005930",
    name: "삼성전자",
    market: "kospi",
    category: "contract",
    reportName: `단일판매·공급계약체결 ${idx + 1}`,
    receiptNo: `20261109${String(idx + 1).padStart(6, "0")}`,
    receiptDate: "20261109",
    filer: "삼성전자",
    remarks: "",
    changeRate: 1.5,
  }));
  scenario.reply((url) => url.pathname === "/api/market-overview/pro", {
    body: {
      ...base,
      disclosures: {
        status: "ok",
        value: {
          totalMatched: 35,
          counts: { contract: 30, shareholder: 0, earnings: 0, capital: 5 },
          items,
        },
      },
    },
  });
  await page.goto("/market");
  const disc = card(page, "핵심 공시 레이더");
  await expect(disc.getByTestId("disclosure-total")).toHaveText("총 35건 중 최근 30건");
  const filters = disc.getByRole("group", { name: "공시 유형 필터" });
  await expect(filters.getByRole("button", { name: /전체/ })).toContainText("30");
  await expect(filters.getByRole("button", { name: /수주·계약/ })).toContainText("30");
  const capitalBtn = filters.getByRole("button", { name: /증자·CB/ });
  await expect(capitalBtn).toContainText("0");
  await filters.getByRole("button", { name: /수주·계약/ }).click();
  await expect(disc.locator(".mk-disc-item")).toHaveCount(30);
  await capitalBtn.click();
  await expect(disc.locator(".mk-disc-item")).toHaveCount(0);
});

test.describe("시장 종합 레이아웃", () => {
  const OVERVIEW_ROUTES = ["sectors", "flow", "flow/intraday", "turnover"] as const;
  const ROWS_OF_A_LONG_RANKING = 14;
  const longRanking = (): RankingRow[] => Array.from({ length: ROWS_OF_A_LONG_RANKING }, (_, index) => ({ ...RANKING_ROWS.kospi.tradeAmount[0]!, rank: index + 1, code: `00${1000 + index}`, name: `종목${index + 1}` }));
  const rankingPage = (scenario: Scenario, rows: RankingRow[]): RankingPage => ({ rows, pages: 1, end: true, limited: false, hidden: 0, fetchedAt: Math.floor(scenario.now / 1000), source: "kiwoom" });
  const heightsOfCards = (page: Page) => page.locator(".mk-grid > [data-card]").evaluateAll((cards) => Object.fromEntries(cards.map((c) => [c.getAttribute("data-card")!, c.getBoundingClientRect().height])));

  async function expectSameCardHeightsBeforeAndAfterLoading(page: Page, scenario: Scenario, rankingRows: number) {
    await page.setViewportSize({ width: 1024, height: 900 });
    const indexKospi = scenario.hold((url) => url.pathname === "/api/market-overview/index" && url.searchParams.get("market") === "kospi");
    const indexKosdaq = scenario.hold((url) => url.pathname === "/api/market-overview/index" && url.searchParams.get("market") === "kosdaq");
    const derived = scenario.hold((url) => url.pathname === "/api/market-overview/derived");
    const pro = scenario.hold((url) => url.pathname === "/api/market-overview/pro");
    const overview = OVERVIEW_ROUTES.map((route) => ({ route, held: scenario.hold((url) => url.pathname === `/api/market-overview/${route}`) }));
    const ranking = scenario.hold((url, request) => url.pathname === "/api/rankings" && request.method() === "POST");
    await page.goto("/market");
    await Promise.all([indexKospi.received, indexKosdaq.received, derived.received, pro.received, ...overview.map(({ held }) => held.received), ranking.received]);
    await expect(main(page).getByRole("status").first()).toBeVisible();
    const loading = await heightsOfCards(page);

    indexKospi.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/index?market=kospi"), "GET")!);
    indexKosdaq.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/index?market=kosdaq"), "GET")!);
    derived.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/derived?scope=all"), "GET")!);
    pro.reply(marketOverviewBaseline(new URL("http://host/api/market-overview/pro?scope=all"), "GET")!);
    for (const { route, held } of overview) held.reply(marketOverviewBaseline(new URL(`http://host/api/market-overview/${route}?market=kospi`), "GET")!);
    ranking.reply({ body: rankingPage(scenario, longRanking().slice(0, rankingRows)) });
    const stocks = main(page).getByRole("region", { name: "종목", exact: true });
    await expect(rankingRows === 0 ? stocks.getByText("순위가 비어 있습니다") : stocks.getByRole("button", { name: "종목1", exact: true })).toBeVisible();
    await expect(main(page).getByRole("region", { name: "지수·폭" }).getByText("코스피", { exact: true })).toBeVisible();
    await expect(main(page).getByRole("region", { name: "지수·폭" }).getByText("코스닥", { exact: true })).toBeVisible();
    await expect(main(page).getByRole("region", { name: "업종 지도" }).getByRole("button").first()).toBeVisible();
    await expect(main(page).getByRole("region", { name: "거래대금 추이" }).locator(".mk-turnover li").first()).toBeVisible();
    await expect(main(page).getByRole("region", { name: "누가 사고 파나" }).locator(".mk-line").first()).toBeVisible();
    await expect(main(page).getByRole("region", { name: "시장 체력 X-Ray" }).getByText("KRX 정규장")).toBeVisible();
    await expect(main(page).getByRole("region", { name: "핵심 공시 레이더" }).locator(".mk-disc-item").first()).toBeVisible();
    const loaded = await heightsOfCards(page);

    expect(Object.keys(loaded).sort()).toEqual(Object.keys(loading).sort());
    const drift = Object.fromEntries(Object.keys(loaded).map((c) => [c, `${Math.round(loading[c]!)} → ${Math.round(loaded[c]!)}`]));
    for (const c of Object.keys(loaded)) expect(Math.abs(loaded[c]! - loading[c]!), `순위 ${rankingRows}줄 ${JSON.stringify(drift)}`).toBeLessThanOrEqual(1);
  }

  for (const rankingRows of [ROWS_OF_A_LONG_RANKING, 10, 5, 0]) {
    test(`시장 종합 1024px 카드 높이는 불러오기 전후가 같다 (순위 ${rankingRows}줄)`, async ({ page, scenario }) => {
      await expectSameCardHeightsBeforeAndAfterLoading(page, scenario, rankingRows);
    });
  }

  test("390px 시장 종합 조작 묶음은 묶음 안에서 줄을 바꾸지 않는다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/market");
    const controls = page.locator(".mk-controls");
    const scopeBar = page.locator(".mk-scope-bar");
    await expect(controls.getByRole("group", { name: "기간" })).toBeVisible();
    await expect(scopeBar.getByRole("group", { name: "시장 범위" })).toBeVisible();
    const measureGroup = (selector: string) =>
      page.locator(selector).evaluate((row) => {
        const rowBox = row.getBoundingClientRect();
        const bundles = [...row.querySelectorAll<HTMLElement>('[role="group"]')].map((bundle) => {
          const bundleBox = bundle.getBoundingClientRect();
          const tops = [...bundle.querySelectorAll("button")].map((button) => button.getBoundingClientRect().top);
          return { label: bundle.getAttribute("aria-label"), spread: Math.max(...tops) - Math.min(...tops), overflowRight: bundleBox.right - rowBox.right, overflowLeft: rowBox.left - bundleBox.left };
        });
        return { bundles, rowOverflow: row.scrollWidth - row.clientWidth };
      });
    const controlLayout = await measureGroup(".mk-controls");
    const scopeLayout = await measureGroup(".mk-scope-bar");
    expect(controlLayout.bundles.map((bundle) => bundle.label)).toEqual(["기간"]);
    expect(scopeLayout.bundles.map((bundle) => bundle.label)).toEqual(["시장 범위"]);
    for (const layout of [controlLayout, scopeLayout]) {
      for (const bundle of layout.bundles) {
        expect(bundle.spread, JSON.stringify(layout)).toBeLessThanOrEqual(1);
        expect(bundle.overflowRight, JSON.stringify(layout)).toBeLessThanOrEqual(1);
        expect(bundle.overflowLeft, JSON.stringify(layout)).toBeLessThanOrEqual(1);
      }
      expect(layout.rowOverflow, JSON.stringify(layout)).toBeLessThanOrEqual(0);
    }
    const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(documentOverflow).toBeLessThanOrEqual(0);
  });

  test("시장 종합 종목 표의 더 보기는 남은 종목을 모두 펼친다", async ({ page, scenario }) => {
    scenario.reply((url, request) => url.pathname === "/api/rankings" && request.method() === "POST", { body: rankingPage(scenario, longRanking()) });
    await page.goto("/market");
    const stocks = main(page).getByRole("region", { name: "종목", exact: true });
    await expect(stocks.locator(".mk-stock-row")).toHaveCount(10);
    await stocks.getByRole("button", { name: `더 보기 (${ROWS_OF_A_LONG_RANKING - 10})` }).click();
    await expect(stocks.locator(".mk-stock-row")).toHaveCount(ROWS_OF_A_LONG_RANKING);
    await expect(stocks.getByRole("button", { name: /^더 보기/ })).toHaveCount(0);
  });
});
