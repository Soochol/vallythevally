import type { Page } from "@playwright/test";
import type { EtfFundDetail } from "../src/api/generated/EtfFundDetail";
import { ETF_DETAILS, etfDetailOf, etfHoldersOf } from "./fixtures/etf-data";
import { contrastOf, inkAndFill } from "./contrast";
import { cell, expect, type Scenario, test } from "./harness";

const MEGA = etfDetailOf("444200");
const SEMI = etfDetailOf("091160");

const basketBox = (page: Page, code: string) => page.locator(`.etf-compare[data-basket-code="${code}"]`);
const matrix = (page: Page) => page.getByRole("table", { name: "겹침 행렬" });
const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const minBps = (a: readonly { code: string; weightBps: number }[], b: readonly { code: string; weightBps: number }[]) =>
  a.reduce((sum, x) => sum + Math.min(x.weightBps, b.find((y) => y.code === x.code)?.weightBps ?? 0), 0);

test("바구니에 3개를 담으면 3×3 행렬이 보이고 주소에 남아 새로 고침해도 같다", async ({ page }) => {
  await page.goto("/etf?tab=overlap");
  await expect(page.getByRole("tabpanel")).toContainText("2개 이상");
  for (const [index, detail] of ETF_DETAILS.entries()) {
    await basketBox(page, detail.fund.code).click();
    await expect(page.getByText(`비교 바구니 ${index + 1}/4`)).toBeVisible();
  }
  await expect(page).toHaveURL(/tab=overlap&basket=444200%2C091160%2C426030$/);
  await expect(matrix(page).locator("tbody tr")).toHaveCount(3);
  await expect(matrix(page).locator(".etf-matrix-cell")).toHaveCount(9);
  await expect(matrix(page).locator('[data-row="444200"][data-column="091160"]')).toHaveText(percent(minBps(MEGA.holdings, SEMI.holdings)));
  await expect(matrix(page).locator('[data-row="444200"][data-column="444200"]')).toHaveText("—");

  await page.reload();
  await expect(matrix(page).locator(".etf-matrix-cell")).toHaveCount(9);
  await expect(basketBox(page, "091160")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("비교 바구니 3/4")).toBeVisible();
});

test("5번째는 담기지 않고 이유가 보인다", async ({ page }) => {
  await page.goto("/etf?tab=overlap&basket=a1,a2,a3,444200");
  await expect(page.getByText("비교 바구니 4/4")).toBeVisible();
  await basketBox(page, "091160").click();
  await expect(page.getByRole("alert").filter({ hasText: "4개까지" })).toBeVisible();
  await expect(basketBox(page, "091160")).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(/basket=a1,a2,a3,444200$/);
  await basketBox(page, "444200").click();
  await expect(page.getByRole("alert").filter({ hasText: "4개까지" })).toHaveCount(0);
});

test("행렬 칸을 누르면 나비 막대에 공통 종목이 보이고 종목을 누르면 차트로 간다", async ({ page }) => {
  await page.goto("/etf?tab=overlap&basket=444200,091160,426030");
  await matrix(page).locator('[data-row="444200"][data-column="091160"]').click();
  const butterfly = page.getByRole("region", { name: "공통 종목 나비 막대" });
  const common = MEGA.holdings.filter((h) => SEMI.holdings.some((s) => s.code === h.code));
  await expect(butterfly.locator(".etf-butterfly-row")).toHaveCount(common.length);
  for (const h of common) {
    const other = SEMI.holdings.find((s) => s.code === h.code)!;
    const row = butterfly.locator(`.etf-butterfly-row[data-code="${h.code}"]`);
    await expect(row.getByRole("img", { name: `${MEGA.fund.name} ${h.name} ${percent(h.weightBps)}` })).toBeVisible();
    await expect(row.getByRole("img", { name: `${SEMI.fund.name} ${h.name} ${percent(other.weightBps)}` })).toBeVisible();
  }
  await expect(butterfly.locator(".etf-butterfly-row", { hasText: "에코프로" })).toHaveCount(1);
  await expect(butterfly.locator(".etf-butterfly-row", { hasText: "합성종목" })).toHaveCount(0);

  await butterfly.getByRole("button", { name: "SK하이닉스 연동 차트로 보내기" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스/);
});

test("역추적에서 종목을 찾으면 담은 ETF가 보이고 행을 누르면 그 ETF의 구성 탭이 열린다", async ({ page }) => {
  await page.goto("/etf?tab=reverse");
  await page.getByRole("searchbox", { name: "종목 이름·코드 검색" }).fill("삼성전자");
  await page.getByRole("list", { name: "종목 검색 결과" }).locator('[data-code="005930"]').click();
  await expect(page).toHaveURL(/stock=005930/);
  const rows = page.getByRole("table", { name: "담은 ETF 표" }).locator("tbody tr");
  const holders = etfHoldersOf("005930").holders;
  await expect(rows).toHaveCount(holders.length);
  for (const holder of holders) await expect(rows.locator(`xpath=self::tr[@data-code="${holder.fund.code}"]`)).toContainText(percent(holder.weightBps));

  await page.reload();
  await expect(rows).toHaveCount(holders.length);

  await rows.locator('xpath=self::tr[@data-code="091160"]').click();
  await expect(page).toHaveURL(/code=091160&tab=holdings/);
  await expect(page.getByRole("tab", { name: "구성" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: SEMI.fund.name, level: 2 })).toBeVisible();
});

test("겹침 행렬의 숫자 칸은 대비가 4.5:1 이상이고 대각선은 —다", async ({ page, scenario }) => {
  scenario.reply("/api/etf/funds/091160", { body: { ...SEMI, holdings: MEGA.holdings } });
  await page.goto("/etf?tab=overlap&basket=444200,091160,426030");
  const numbers = matrix(page).locator(".etf-matrix-cell:not(:disabled)");
  await expect(numbers).toHaveCount(6);
  await expect(matrix(page).locator('[data-row="444200"][data-column="091160"]')).toHaveAttribute("data-bps", "10000");
  const pairs = await inkAndFill(numbers);
  const surface = await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor);
  for (const ratio of await contrastOf(page, pairs, surface)) expect(ratio).toBeGreaterThanOrEqual(4.5);
  const diagonal = matrix(page).locator(".etf-matrix-cell:disabled");
  await expect(diagonal).toHaveCount(3);
  for (const text of await diagonal.allTextContents()) expect(text).toBe("—");
  await expect(page.getByRole("heading", { name: /^겹침 비율/ })).toBeVisible();
});

test("나비 막대 값은 기울임꼴이 아니고 둘째 막대는 상승색이 아니다", async ({ page }) => {
  await page.goto("/etf?tab=overlap&basket=444200,091160");
  await matrix(page).locator('[data-row="444200"][data-column="091160"]').click();
  const butterfly = page.getByRole("region", { name: "공통 종목 나비 막대" });
  await expect(butterfly.locator(".etf-butterfly-row").first()).toBeVisible();
  await expect(butterfly.locator("em")).toHaveCount(0);
  const styles = await butterfly.locator(".etf-bar-value").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontStyle));
  expect(styles.length).toBeGreaterThan(0);
  for (const style of styles) expect(style).toBe("normal");
  const [up, right] = await Promise.all([
    page.evaluate(() => { const probe = document.createElement("i"); probe.style.color = "var(--up)"; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; }),
    butterfly.locator(".etf-bar-right i").first().evaluate((node) => getComputedStyle(node).backgroundColor),
  ]);
  expect(right).not.toBe(up);
});

test("겹침 3-칼럼 알파 뷰는 양쪽 고유 베팅을 보이고 공통 나비만 보기로 전환된다", async ({ page }) => {
  await page.goto("/etf?tab=overlap&basket=444200,091160");
  await matrix(page).locator('[data-row="444200"][data-column="091160"]').click();
  await expect(page.getByRole("region", { name: "겹침 대비 차별화 요약" })).toContainText("차별화(Active Share)");
  await expect(page.getByRole("region", { name: `${MEGA.fund.name} 고유 베팅` })).toContainText("현대차");
  await expect(page.getByRole("region", { name: `${SEMI.fund.name} 고유 베팅` })).toContainText("SK스퀘어");

  await page.getByRole("group", { name: "비교 보기 방식" }).getByRole("button", { name: "공통 나비만" }).click();
  await expect(page.getByRole("region", { name: `${MEGA.fund.name} 고유 베팅` })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "공통 종목 나비 막대" })).toBeVisible();
});

test("역추적은 유형 필터로 담은 ETF를 거르고 비교 바구니에 바로 담는다", async ({ page }) => {
  await page.goto("/etf?tab=reverse&stock=005930");
  const rows = page.getByRole("table", { name: "담은 ETF 표" }).locator("tbody tr");
  await expect(rows).toHaveCount(2);

  await page.getByRole("group", { name: "담은 ETF 유형" }).getByRole("button", { name: "액티브" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-code", "444200");

  await page.getByRole("button", { name: `${MEGA.fund.name} 비교 담기` }).click();
  await expect(page.getByText("비교 바구니 1/4")).toBeVisible();
});

test("유사 ETF 탭은 겹침 순으로 보여 주고 나비 비교 클릭으로 3-칼럼 알파 뷰를 즉시 연다", async ({ page }) => {
  await page.goto("/etf?code=444200&tab=similar");
  await expect(page.getByRole("tab", { name: "유사 ETF" })).toHaveAttribute("aria-selected", "true");

  const table = page.getByRole("table", { name: "유사 ETF 표" });
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-code", "426030");
  await expect(rows.nth(0)).toContainText("51.00%");
  await expect(rows.nth(0)).toContainText("49.00%");
  await expect(rows.nth(0)).toContainText("4개");
  await expect(rows.nth(1)).toHaveAttribute("data-code", "091160");
  await expect(rows.nth(1)).toContainText("43.00%");

  await rows.nth(1).getByRole("button", { name: `${SEMI.fund.name} 나비 비교` }).click();
  await expect(page).toHaveURL(/tab=overlap&basket=444200%2C091160$/);
  await expect(page.getByRole("region", { name: "겹침 대비 차별화 요약" })).toBeVisible();
  await expect(page.getByRole("region", { name: `${MEGA.fund.name} 고유 베팅` })).toContainText("현대차");
  await expect(page.getByRole("region", { name: `${SEMI.fund.name} 고유 베팅` })).toContainText("SK스퀘어");
  await expect(page.getByRole("region", { name: "공통 종목 나비 막대" })).toBeVisible();
});

test.describe("390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("모바일에서 겹침 행렬과 나비 막대가 가로 오버플로 없이 표시된다", async ({ page }) => {
    await page.goto("/etf?tab=overlap&basket=444200,091160,426030");
    await expect(matrix(page)).toBeVisible();
    const wrapOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(wrapOverflow).toBe(true);

    await matrix(page).locator('[data-row="444200"][data-column="091160"]').click();
    const butterfly = page.getByRole("region", { name: "공통 종목 나비 막대" });
    await expect(butterfly.locator(".etf-butterfly-row").first()).toBeVisible();
    const trackWidths = await butterfly.locator(".etf-bar-track").evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().width),
    );
    expect(trackWidths.length).toBeGreaterThan(0);
    for (const width of trackWidths) expect(width).toBeGreaterThanOrEqual(20);
  });
});

test.describe("390px/320px 좁은 폭", () => {
  const LONG_NAME_SUFFIX = " 글로벌 반도체 소부장 액티브 커버드콜 합성";
  const longNamedEtfs = (): EtfFundDetail[] => [
    ...ETF_DETAILS,
    { ...ETF_DETAILS[0]!, fund: { ...ETF_DETAILS[0]!.fund, code: "069500", name: "KODEX 200" } },
  ].map((detail) => ({ ...detail, fund: { ...detail.fund, name: `${detail.fund.name}${LONG_NAME_SUFFIX}` } }));

  const serveLongNamedEtfs = (scenario: Scenario) => {
    const details = longNamedEtfs();
    scenario.reply((url) => url.pathname === "/api/etf/funds", { body: { funds: details.map((detail) => detail.fund) } });
    for (const detail of details) scenario.reply((url) => url.pathname === `/api/etf/funds/${detail.fund.code}`, { body: detail });
    return details.map((detail) => detail.fund.code);
  };

  const overflowOf = (page: Page, selector: string) =>
    page.locator(selector).first().evaluate((element) => {
      const container = element.parentElement!;
      const right = container.getBoundingClientRect().right;
      const farthest = Math.max(...[element, ...element.querySelectorAll("*")].map((node) => node.getBoundingClientRect().right));
      return { scrollWidth: element.scrollWidth, parentClientWidth: container.clientWidth, spill: farthest - right };
    });

  test("ETF 좁은 화면에서 겹침 행렬과 목록 칩이 가로로 넘치지 않는다", async ({ page, scenario }) => {
    const basket = serveLongNamedEtfs(scenario).join(",");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/etf?tab=overlap&basket=${basket}`);
      await expect(page.getByRole("table", { name: "겹침 행렬" }).locator(".etf-matrix-cell")).toHaveCount(16);
      const matrixBox = await overflowOf(page, ".etf-matrix");
      expect(matrixBox.scrollWidth, `${width}px 행렬 ${JSON.stringify(matrixBox)}`).toBeLessThanOrEqual(matrixBox.parentClientWidth);
      expect(matrixBox.spill, `${width}px 행렬 ${JSON.stringify(matrixBox)}`).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}px 문서`).toBeLessThanOrEqual(0);

      await page.goto(`/etf?basket=${basket}`);
      await expect(page.getByRole("list", { name: "비교 바구니" }).getByRole("listitem")).toHaveCount(4);
      const chips = await overflowOf(page, ".etf-basket-chips");
      expect(chips.scrollWidth, `${width}px 칩 ${JSON.stringify(chips)}`).toBeLessThanOrEqual(chips.parentClientWidth);
      expect(chips.spill, `${width}px 칩 ${JSON.stringify(chips)}`).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}px 문서`).toBeLessThanOrEqual(0);
    }
  });
});
