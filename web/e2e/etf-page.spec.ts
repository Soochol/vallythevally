import type { Page } from "@playwright/test";
import { ETF_DETAILS, ETF_FUNDS, etfDetailOf, withEtfMa } from "./fixtures/etf-data";
import { contrastOf, inkAndFill } from "./contrast";
import { cell, expect, test } from "./harness";
import { selectOption } from "./select-option";

const MEGA = etfDetailOf("444200");
const FAILED = etfDetailOf("426030");

const list = (page: Page) => page.getByRole("list", { name: "ETF" });
const fundButton = (page: Page, code: string) => list(page).locator(`[data-code="${code}"]`);
const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;

test("목록 검색과 액티브 필터가 행을 줄인다", async ({ page }) => {
  await page.goto("/etf");
  await expect(list(page).locator(".etf-fund")).toHaveCount(ETF_FUNDS.funds.length);

  await page.getByRole("searchbox", { name: "ETF 이름·코드 검색" }).fill("반도체");
  await expect(list(page).locator(".etf-fund")).toHaveCount(1);
  await expect(fundButton(page, "091160")).toBeVisible();

  await page.getByRole("searchbox", { name: "ETF 이름·코드 검색" }).fill("");
  await page.getByRole("group", { name: "운용 방식" }).getByRole("button", { name: "액티브" }).click();
  await expect(list(page).locator(".etf-fund")).toHaveCount(2);
  await expect(fundButton(page, "091160")).toHaveCount(0);

  await selectOption(page.getByRole("combobox", { name: "운용사" }), "신한자산운용");
  await expect(list(page).locator(".etf-fund")).toHaveCount(1);
  await expect(fundButton(page, "444200")).toBeVisible();
});

test("ETF를 고르면 주소가 /etf?code=...가 되고 새로 고침해도 같은 ETF가 열린다", async ({ page }) => {
  await page.goto("/etf");
  await fundButton(page, "444200").click();
  await expect(page).toHaveURL(/\/etf\?code=444200&tab=holdings$/);
  await expect(page.getByRole("heading", { name: MEGA.fund.name, level: 2 })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/code=444200/);
  await expect(page.getByRole("heading", { name: MEGA.fund.name, level: 2 })).toBeVisible();
  await expect(fundButton(page, "444200")).toHaveAttribute("aria-pressed", "true");
});

test("요약 4칸과 트리맵·표가 응답 값과 맞다", async ({ page }) => {
  await page.goto("/etf?code=444200&tab=holdings");
  const summary = page.getByLabel("요약 지표");
  await expect(summary).toContainText("종목 수");
  await expect(summary.locator(".etf-summary-cell").nth(0).locator("dd")).toHaveText(`${MEGA.fund.holdingsCount}개`);
  await expect(summary.locator(".etf-summary-cell").nth(1).locator("dd")).toHaveText(percent(MEGA.fund.top5WeightBps));
  await expect(summary.locator(".etf-summary-cell").nth(2).locator("dd")).toHaveText(MEGA.fund.effectiveHoldings.toFixed(1));
  await expect(summary.locator(".etf-summary-cell").nth(3).locator("dd")).toHaveText(MEGA.fund.status.holdingsAsOf);

  const treemap = page.getByRole("group", { name: "구성 종목 트리맵" });
  await expect(treemap.getByRole("button")).toHaveCount(MEGA.holdings.length);
  for (const h of MEGA.holdings) await expect(treemap.locator(`[data-code="${h.code}"]`)).toHaveAttribute("aria-label", `${h.name} ${percent(h.weightBps)}`);

  const rows = page.getByRole("table", { name: "구성 종목 표" }).locator("tbody tr");
  await expect(rows).toHaveCount(MEGA.holdings.length);
  const ranked = MEGA.holdings.toSorted((a, b) => b.weightBps - a.weightBps);
  let cumulative = 0;
  for (const [i, h] of ranked.entries()) {
    cumulative += h.weightBps;
    await expect(rows.nth(i).locator(".etf-rank")).toHaveText(String(i + 1));
    await expect(rows.nth(i).locator(".etf-cumulative")).toHaveText(percent(cumulative));
    await expect(rows.nth(i)).toContainText(h.name);
    await expect(rows.nth(i)).toContainText(percent(h.weightBps));
  }

  const curve = page.getByRole("img", { name: /^누적 비중 곡선/ });
  const top5 = MEGA.fund.top5WeightBps;
  await expect(curve.locator('[data-rank="5"]')).toHaveAttribute("data-cumulative-bps", String(top5));
});

test("트리맵 칸을 누르면 연동 색 차트에 그 종목이 열린다", async ({ page }) => {
  await page.goto("/etf?code=444200");
  await page.getByRole("group", { name: "구성 종목 트리맵" }).locator('[data-code="000660"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스/);
});

test("표 행을 누르면 연동 색 차트에 그 종목이 열린다", async ({ page }) => {
  await page.goto("/etf?code=091160");
  await page.getByRole("table", { name: "구성 종목 표" }).locator('tr[data-code="005930"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성전자/);
});

test("출처가 갱신 실패면 '갱신 실패'와 마지막 성공 기준일이 보인다", async ({ page }) => {
  await page.goto("/etf?code=444200");
  const freshness = page.getByRole("status", { name: "자료 신선도" });
  await expect(freshness).toHaveText(`자료 출처 스냅샷 · 기준일 ${MEGA.fund.status.holdingsAsOf}`);

  await fundButton(page, "426030").click();
  await expect(freshness).toContainText("갱신 실패");
  await expect(freshness).toContainText(`마지막 성공 기준일 ${FAILED.fund.status.holdingsAsOf}`);
});

test("이평선 칸이 있으면 점 3개가 상태대로 보이고, null이면 빈 자리다", async ({ page, scenario }) => {
  await page.goto("/etf?code=444200");
  const samsung = page.getByRole("table", { name: "구성 종목 표" }).locator('tr[data-code="005930"]');
  await expect(samsung.getByRole("img")).toHaveCount(3);
  await expect(samsung.getByRole("img", { name: "20일선 상회" })).toHaveAttribute("data-state", "above");
  await expect(samsung.getByRole("img", { name: "60일선 하회" })).toHaveAttribute("data-state", "below");
  await expect(samsung.getByRole("img", { name: "120일선 일치" })).toHaveAttribute("data-state", "equal");

  const row = page.getByRole("table", { name: "구성 종목 표" }).locator('tr[data-code="051910"]');
  await expect(row.getByRole("img")).toHaveCount(0);
  await expect(row.locator(".etf-ma-slot")).toHaveCount(3);

  scenario.reply("/api/etf/funds/091160", { body: withEtfMa("091160", { ma20: "below", ma60: null, ma120: "above" }) });
  await page.goto("/etf?code=091160");
  const semi = page.getByRole("table", { name: "구성 종목 표" }).locator('tr[data-code="000660"]');
  await expect(semi.getByRole("img")).toHaveCount(2);
  await expect(semi.locator(".etf-ma-slot")).toHaveCount(3);
});

test("없는 코드로 오면 목록과 '찾을 수 없음' 안내가 보인다", async ({ page }) => {
  await page.goto("/etf?code=999999");
  await expect(page.getByText("찾을 수 없음", { exact: true })).toBeVisible();
  await expect(list(page).locator(".etf-fund")).toHaveCount(ETF_DETAILS.length);
  await fundButton(page, "091160").click();
  await expect(page).toHaveURL(/code=091160/);
  await expect(page.getByText("찾을 수 없음", { exact: true })).toHaveCount(0);
});

test("편입 변경 탭은 주소에 남고 구성 탭으로 돌아올 수 있다", async ({ page }) => {
  await page.goto("/etf?code=444200&tab=history");
  await expect(page.getByRole("tab", { name: "편입 변경" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "구성" }).click();
  await expect(page).toHaveURL(/tab=holdings/);
  await expect(page.getByRole("group", { name: "구성 종목 트리맵" })).toBeVisible();
});

const withHoldingCount = (count: number) => {
  const extra = Array.from({ length: count - MEGA.holdings.length }, (_, index) => ({ code: `9${String(index).padStart(5, "0")}`, name: `보강종목${index + 1}`, weightBps: 90 - index, ma: { ma20: null, ma60: null, ma120: null } }));
  return { ...MEGA, holdings: [...MEGA.holdings, ...extra] };
};

test.describe("1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("트리맵의 모든 글자 타일은 글자와 바탕 대비가 4.5:1 이상이다", async ({ page }) => {
    await page.goto("/etf?code=444200");
    const tiles = page.getByRole("group", { name: "구성 종목 트리맵" }).locator('.etf-tile:not([data-label="none"])');
    await expect.poll(() => tiles.count()).toBeGreaterThan(0);
    const pairs = await inkAndFill(tiles);
    for (const pair of pairs) expect(pair.opacity).toBe("1");
    for (const ratio of await contrastOf(page, pairs)) expect(ratio).toBeGreaterThanOrEqual(4.5);
    const labels = page.getByRole("group", { name: "구성 종목 트리맵" }).locator(".etf-tile-name, .etf-tile-weight");
    for (const opacity of await labels.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).opacity))) expect(opacity).toBe("1");
  });

  test("누적 곡선의 글자는 11px 이상이고 상위 5와 상위 10 표식이 겹치지 않는다", async ({ page, scenario }) => {
    scenario.reply("/api/etf/funds/444200", { body: withHoldingCount(14) });
    await page.goto("/etf?code=444200");
    const curve = page.getByRole("img", { name: /^누적 비중 곡선/ });
    await expect(curve.locator('[data-rank="10"] text')).toBeVisible();
    for (const size of await curve.locator("text").evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)))) expect(size).toBeGreaterThanOrEqual(11);
    const [five, ten] = await Promise.all(["5", "10"].map((rank) => curve.locator(`[data-rank="${rank}"] text`).evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    })));
    const apart = five!.right <= ten!.left || ten!.right <= five!.left || five!.bottom <= ten!.top || ten!.bottom <= five!.top;
    expect(apart).toBe(true);
    const box = await page.locator(".etf-curve-box").boundingBox();
    expect(box!.height).toBeGreaterThan(150);
  });

  test("ETF 화면에는 브라우저 기본 select가 없다", async ({ page }) => {
    await page.goto("/etf?code=444200");
    await expect(list(page).locator(".etf-fund").first()).toBeVisible();
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "운용사" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "정렬" })).toBeVisible();
    await page.getByRole("tab", { name: "역추적" }).click();
    await expect(page.locator("select")).toHaveCount(0);
  });

  test("정렬을 바꾸면 목록 순서가 바뀐다", async ({ page }) => {
    await page.goto("/etf");
    const codes = () => list(page).locator("[data-code]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-code")));
    const byTop5 = ETF_FUNDS.funds.toSorted((a, b) => b.top5WeightBps - a.top5WeightBps).map((fund) => fund.code);
    await selectOption(page.getByRole("combobox", { name: "정렬" }), "top5");
    await expect.poll(codes).toEqual(byTop5);
  });

  test("목록에서 비교 토글로 둘을 담으면 칩 둘과 겹침 보기가 보인다", async ({ page }) => {
    await page.goto("/etf");
    const toggle = (code: string) => page.locator(`.etf-compare[data-basket-code="${code}"]`);
    await expect(page.getByRole("button", { name: "겹침 보기" })).toBeDisabled();
    await toggle("444200").click();
    await toggle("091160").click();
    await expect(toggle("444200")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("list", { name: "비교 바구니" }).locator("li")).toHaveCount(2);
    const overlap = page.getByRole("button", { name: "겹침 보기" });
    await expect(overlap).toBeEnabled();
    expect((await toggle("444200").boundingBox())!.height).toBeGreaterThanOrEqual(24);
    await overlap.click();
    await expect(page).toHaveURL(/tab=overlap&basket=444200%2C091160$/);
    await expect(page.getByRole("table", { name: "겹침 행렬" })).toBeVisible();
  });

  test("고른 줄의 보조 글자는 대비가 4.5:1 이상이다", async ({ page }) => {
    await page.goto("/etf?code=444200");
    const picked = fundButton(page, "444200");
    await expect(picked).toHaveAttribute("aria-pressed", "true");
    const subs = picked.locator(".etf-fund-code, .etf-fund-meta, .etf-fund-issuer, .etf-conc-value");
    const inks = await subs.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
    const fill = await picked.evaluate((node) => getComputedStyle(node).backgroundColor);
    const surface = await page.locator(".etf-rail").evaluate((node) => getComputedStyle(node).backgroundColor);
    const ratios = await contrastOf(page, inks.map((ink) => ({ ink, fill, opacity: "1" })), surface);
    expect(ratios.length).toBeGreaterThan(0);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("구성 표는 스무 줄까지 보이고 모두 보기로 펼치며 이평선 범례가 있다", async ({ page, scenario }) => {
    scenario.reply("/api/etf/funds/444200", { body: withHoldingCount(26) });
    await page.goto("/etf?code=444200");
    const rows = page.getByRole("table", { name: "구성 종목 표" }).locator("tbody tr");
    await expect(rows).toHaveCount(20);
    await expect(page.locator(".etf-ma-legend")).toContainText("▲ 위");
    await expect(page.locator(".etf-ma-legend")).toContainText("▼ 아래");
    await expect(page.locator(".etf-ma-legend")).toContainText("– 같음");
    await expect(page.locator(".etf-table-wrap").first()).not.toHaveAttribute("data-scroll");
    await page.getByRole("button", { name: "모두 보기 (26개)" }).click();
    await expect(rows).toHaveCount(26);
    await expect(page.locator('tr[data-code="005930"] [data-state="above"]').first()).toHaveText("▲");
  });

  test("기본 데스크톱 진입은 동시 매집 레이더를 보이고 수집일이 2일 미만이면 첫 ETF 구성으로 폴백한다", async ({ page, scenario }) => {
    await page.goto("/etf");
    await expect(page.getByRole("tab", { name: "동시 매집" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("table", { name: "동시 매집 종목 표" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);

    scenario.reply("/api/etf/accumulation", {
      body: { window: 5, style: "active", direction: "buy", fromDate: null, toDate: null, collectedDays: 1, maAsOf: null, rows: [] },
    });
    await page.goto("/etf");
    await expect(page).toHaveURL(/\/etf$/);
    await expect(page.getByRole("tab", { name: "구성" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: MEGA.fund.name, level: 2 })).toBeVisible();
  });

  test("트리맵 3-렌즈 전환 시 4.5:1 대비를 유지하고 호버가 누적 곡선과 표를 동기화한다", async ({ page }) => {
    await page.goto("/etf?code=444200&tab=holdings");
    const treemap = page.getByRole("group", { name: "구성 종목 트리맵" });
    const lensGroup = page.getByRole("group", { name: "트리맵 렌즈" });

    for (const lensLabel of ["이평선 추세", "최근 매집", "비중 강도"]) {
      await lensGroup.getByRole("button", { name: lensLabel }).click();
      const tiles = treemap.locator('.etf-tile:not([data-label="none"])');
      await expect.poll(() => tiles.count()).toBeGreaterThan(0);
      const pairs = await inkAndFill(tiles);
      for (const pair of pairs) expect(pair.opacity).toBe("1");
      for (const ratio of await contrastOf(page, pairs)) expect(ratio).toBeGreaterThanOrEqual(4.5);
    }

    await treemap.locator('[data-code="005930"]').hover();
    await expect(page.getByRole("img", { name: /^누적 비중 곡선/ }).locator('[data-hover-rank="2"]')).toBeVisible();
    await expect(page.getByRole("table", { name: "구성 종목 표" }).locator('tr[data-code="005930"]')).toHaveAttribute("data-highlighted", "true");

    await page.getByRole("table", { name: "구성 종목 표" }).getByRole("button", { name: "삼성전자 역추적" }).click();
    await expect(page).toHaveURL(/tab=reverse&stock=005930/);
    await expect(page.getByRole("table", { name: "담은 ETF 표" })).toBeVisible();
  });

  test("도움말 버튼 클릭으로 설명 팝오버가 열리고 Escape·Tab·바깥 클릭으로 닫히며 바깥 클릭을 삼키지 않는다", async ({ page }) => {
    await page.goto("/etf?code=444200&tab=holdings");
    const helpBtn = page.getByRole("button", { name: "실효 종목 수 설명" });
    await expect(helpBtn).toHaveAttribute("aria-expanded", "false");
    await expect(helpBtn).not.toHaveAttribute("title");

    await helpBtn.click();
    const popover = page.getByRole("dialog", { name: "실효 종목 수 설명" });
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("1 ÷ Σ(비중²)");
    await expect(helpBtn).toHaveAttribute("aria-expanded", "true");

    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(helpBtn).toHaveAttribute("aria-expanded", "false");
    await expect(helpBtn).toBeFocused();

    await helpBtn.click();
    await expect(popover).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(popover).toHaveCount(0);

    await helpBtn.click();
    await expect(popover).toBeVisible();
    await page.getByRole("tab", { name: "편입 변경" }).click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "편입 변경" })).toHaveAttribute("aria-selected", "true");
  });

  test("목록의 최근 리밸런싱 배지는 선택·비선택 모두 4.5:1 대비를 지키고 최근 리밸런싱순으로 정렬된다", async ({ page }) => {
    await page.goto("/etf");
    const megaRow = fundButton(page, "444200");
    const activity = megaRow.locator(".etf-fund-activity");
    await expect(activity).toBeVisible();
    await expect(activity).toContainText("▲2");
    await expect(activity).toContainText("▼2");

    const surface = await page.locator(".etf-rail").evaluate((node) => getComputedStyle(node).backgroundColor);
    const defaultInks = await activity.locator("span").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
    const defaultFill = await megaRow.evaluate((node) => getComputedStyle(node).backgroundColor);
    for (const ratio of await contrastOf(page, defaultInks.map((ink) => ({ ink, fill: defaultFill, opacity: "1" })), surface)) {
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }

    await megaRow.click();
    await expect(megaRow).toHaveAttribute("aria-pressed", "true");
    const selectedInks = await activity.locator("span").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
    const selectedFill = await megaRow.evaluate((node) => getComputedStyle(node).backgroundColor);
    for (const ratio of await contrastOf(page, selectedInks.map((ink) => ({ ink, fill: selectedFill, opacity: "1" })), surface)) {
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }

    await selectOption(page.getByRole("combobox", { name: "정렬" }), "activity");
    const codes = () => list(page).locator("[data-code]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-code")));
    await expect.poll(codes).toEqual(["444200", "091160", "426030"]);
  });
});

test.describe("390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("ETF를 고르면 상세만 보이고 목록 버튼으로 돌아간다", async ({ page }) => {
    await page.goto("/etf");
    await expect(list(page)).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
    await fundButton(page, "444200").click();
    await expect(page.getByRole("heading", { name: MEGA.fund.name, level: 2 })).toBeVisible();
    await expect(list(page)).toBeHidden();
    await page.getByRole("button", { name: "목록", exact: true }).click();
    await expect(list(page)).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
  });

  test("주소에 code가 있으면 상세를 연다", async ({ page }) => {
    await page.goto("/etf?code=091160");
    await expect(page.getByRole("heading", { name: "KODEX 반도체", level: 2 })).toBeVisible();
    await expect(list(page)).toBeHidden();
  });
});
