import type { Page } from "@playwright/test";
import type { Screen } from "../src/api/generated/Screen";
import type { ScreenerResult } from "../src/api/generated/ScreenerResult";
import { type App, expect, test } from "./harness";
import { selectOption } from "./select-option";
import { editor, openScreener, panel, results, rows, runButton, savedTo, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ krxMarket: "20261106", clockStart: "20261106203000" });

const screen: Screen = { id: "current", name: "최신 자료 확인", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", field: "close", n: 1, barRange: { start: 0, end: 0 } }] };
const meta = (page: Page) => results(page).getByLabel("결과 자료");
const fail = { apiId: "ka10095", status: 200, body: { return_code: 2, return_msg: "입력 값 오류입니다[1501:시험용 수집 실패]" } };

async function prepare(app: App, page: Page, open = openScreener, fullHistory = true) {
  expect((await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [screen], revision: 1 }) })).status).toBe(200);
  await page.goto("/");
  await open(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  if (!fullHistory) {
    await expect(updateBand(page)).toContainText("과거 이력 이어 받기", { timeout: 60_000 });
    await updateBand(page).getByRole("button", { name: "취소", exact: true }).click();
  }
  await waitForUpdateToFinish(page, "11-06(금)");
}

async function execute(page: Page): Promise<ScreenerResult> {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/screener/run");
  await runButton(page).click();
  const answer = await response;
  expect(answer.status()).toBe(200);
  await expect(results(page)).toHaveAttribute("aria-busy", "false");
  return answer.json();
}

function summaries(result: ScreenerResult, price: number) {
  return result.rows.map((r) => ({ stk_cd: r.symbol, dt: "20261109", cntr_tm: "100000", base_pric: String(r.close), cur_prc: String(r.symbol === "110010" ? price : r.close), open_pric: String(r.close), high_pric: String(Math.max(price, r.close)), low_pric: String(Math.min(price, r.close)), trde_qty: "1000", trde_prica: "100" }));
}

async function quotes(app: App, data: unknown[]) {
  await app.fake.respondWith({ apiId: "ka10095", status: 200, body: { return_code: 0, atn_stk_infr: data } });
}

async function intraday(app: App, page: Page, baseline: ScreenerResult, price: number) {
  await quotes(app, summaries(baseline, price));
  await app.restart({ clockStart: "20261109100000" });
  await page.reload();
  await openScreener(page);
}

async function editRange(page: Page, period: string, start: number, end: number) {
  await panel(page).getByRole("button", { name: "편집", exact: true }).click();
  const dialog = editor(page, "조건식 편집");
  await selectOption(dialog.getByRole("combobox", { name: "조건 1 봉 주기" }), period);
  await dialog.getByRole("textbox", { name: "조건 1 봉 범위 시작" }).fill(String(start));
  await dialog.getByRole("textbox", { name: "조건 1 봉 범위 끝" }).fill(String(end));
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await saved;
  await expect(dialog).toBeHidden();
}

test("수동 실행만 값을 바꾸며 같은 봉 갱신과 새 봉 추가, D/W/M 범위 편집·저장·실행의 날짜와 가격을 구분한다", async ({ app, page }) => {
  await prepare(app, page);
  const baseline = await execute(page);
  const old = baseline.rows.find((r) => r.symbol === "110010")!;
  await intraday(app, page, baseline, old.close + 100);
  const first = await execute(page);
  expect(first.rows.find((r) => r.symbol === "110010")).toMatchObject({ close: old.close + 100, latestBarDate: "2026-11-09", matchedDate: "2026-11-09", provisional: true });
  await expect(rows(page).filter({ hasText: "110010" })).toContainText("잠정");
  const before = await rows(page).filter({ hasText: "110010" }).textContent();
  await quotes(app, summaries(baseline, old.close + 200));
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "스크리너", exact: true }).click();
  await expect(rows(page).filter({ hasText: "110010" })).toHaveText(before!);
  const updated = await execute(page);
  expect(updated.rows.find((r) => r.symbol === "110010")).toMatchObject({ close: old.close + 200, latestBarDate: "2026-11-09", matchedDate: "2026-11-09" });
  for (const period of ["D", "W", "M"]) {
    for (const [start, end] of [[0, 0], [1, 1], [0, 2]]) {
      await editRange(page, period, start!, end!);
      await expect(results(page)).toHaveCount(period === "D" && start === 0 && end === 0 ? 1 : 0);
      const answer = await execute(page);
      const row = answer.rows.find((r) => r.symbol === "110010")!;
      expect(row).toMatchObject({ close: old.close + 200, latestBarDate: "2026-11-09", provisional: true });
      const expected = period === "D" ? (start === 1 ? "2026-11-06" : "2026-11-09") : period === "W" ? (start === 1 ? "2026-11-02" : "2026-11-09") : (start === 1 ? "2026-10-01" : "2026-11-01");
      expect(row.matchedDate).toBe(expected);
      await expect(rows(page).filter({ hasText: "110010" }).locator(`[title="첫 봉 조건 일치 ${expected}"]`)).toBeVisible();
    }
  }
  await editRange(page, "D", 1, 1);
  await panel(page).getByRole("button", { name: "편집", exact: true }).click();
  const dialog = editor(page, "조건식 편집");
  await dialog.getByRole("button", { name: "조건 더하기" }).click();
  await dialog.getByRole("textbox", { name: "조건 2 신고가 기간" }).fill("1");
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await saved;
  const independent = await execute(page);
  expect(independent.rows.find((r) => r.symbol === "110010")).toMatchObject({ matchedDate: "2026-11-06", latestBarDate: "2026-11-09", close: old.close + 200 });
  await expect(meta(page)).toContainText("수집 범위 (KST) 2026-11-09 10:");
  await expect(meta(page)).toContainText("기준 관측일 2026-11-09");
});

test("처음 수집 실패는 빈 상태이며 실행 중과 실패 뒤에는 이전 결과와 원래 수집 범위를 보존한다", async ({ app, page }) => {
  await prepare(app, page);
  await app.fake.respondWith(fail);
  await runButton(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("결과 없음");
  await expect(results(page)).toHaveCount(0);
  await app.fake.reset();
  await execute(page);
  const original = await meta(page).textContent();
  const originalRows = await rows(page).allTextContents();
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const requested = new Promise<void>((r) => { received = r; });
  await app.fake.respondWith(fail);
  await page.route("**/api/screener/run", async (route) => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  await runButton(page).click();
  await requested;
  await expect(results(page)).toHaveAttribute("aria-busy", "true");
  await expect(meta(page)).toHaveText(original!);
  expect(await rows(page).allTextContents()).toEqual(originalRows);
  release();
  await expect(panel(page).getByRole("alert")).toContainText("이전 결과와 수집 시각을 유지합니다");
  await expect(meta(page)).toHaveText(original!);
  expect(await rows(page).allTextContents()).toEqual(originalRows);
});

test("개별 누락으로 판정할 수 없는 빈 결과는 조건 불일치와 구분하고 복구 후 수동 실행한다", async ({ app, page }) => {
  await prepare(app, page);
  const baseline = await execute(page);
  await intraday(app, page, baseline, baseline.rows[0]!.close);
  const partial = summaries(baseline, baseline.rows.find((r) => r.symbol === "110010")!.close).slice(1);
  partial[0]!.dt = "wrong-date";
  await quotes(app, partial);
  const partlyMissing = await execute(page);
  expect(partlyMissing.missingSummary).toBe(2);
  await expect(rows(page)).toHaveCount(8);
  await expect(meta(page)).toContainText("자료 누락 2종목");
  await quotes(app, []);
  const missing = await execute(page);
  expect(missing.missingSummary).toBe(10);
  await expect(meta(page)).toContainText("자료 누락 10종목");
  await expect(results(page)).toContainText("자료 누락 10종목은 판정할 수 없습니다");
  await quotes(app, summaries(baseline, baseline.rows.find((r) => r.symbol === "110010")!.close));
  const restored = await execute(page);
  expect(restored.missingSummary).toBe(0);
  await expect(rows(page)).toHaveCount(10);
});

for (const width of [1440, 1024, 390, 360, 320]) {
  test(`결과 자료와 오래된 최신 봉 날짜가 ${width}px 화면에서 유지된다`, async ({ app, page }, info) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    const open = width < 600 ? async (p: Page) => { await p.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "스크리너" }).click(); } : openScreener;
    await prepare(app, page, open);
    const answer = await execute(page);
    const halted = answer.rows.find((r) => r.symbol === "110040")!;
    expect(halted.provisional).toBe(false);
    expect(halted.latestBarDate < answer.asOf).toBe(true);
    await expect(rows(page).filter({ hasText: "110040" }).locator(`[aria-label*="최신 일봉 ${halted.latestBarDate}"]`)).toBeVisible();
    await expect(meta(page)).toContainText("수집 범위 (KST)");
    expect(await panel(page).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await rows(page).filter({ hasText: "110040" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`result-${width}.png`), fullPage: true });
  });
}

test("옛 SQLite 조건식은 안내 없이 이전되고 편집·저장·서버 재시작 뒤에도 범위를 유지한다", async ({ app, page }) => {
  const legacy = { ...screen, conditions: [{ kind: "new_high", period: "D", field: "close", n: 1, m: 3 }] };
  await app.restart({ legacyScreens: [legacy] });
  await page.goto("/");
  await openScreener(page);
  await expect(panel(page).getByRole("list", { name: "조건" })).toContainText("0~2봉 전");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/변환|이전되었습니다|새 규칙으로/)).toHaveCount(0);
  const migrated = await (await fetch(`${app.url}/api/screens`)).json();
  expect(migrated).toMatchObject({ revision: 11, screens: [{ ...screen, conditions: [{ kind: "new_high", period: "D", field: "close", n: 1, barRange: { start: 0, end: 2 } }] }] });
  await editRange(page, "M", 1, 1);
  await app.restart();
  await page.reload();
  await openScreener(page);
  await expect(panel(page).getByRole("list", { name: "조건" })).toContainText("월봉 1봉 전");
  expect((await (await fetch(`${app.url}/api/screens`)).json()).revision).toBe(12);
  await expect(page.getByText(/변환|이전되었습니다|새 규칙으로/)).toHaveCount(0);
});

test("주말에는 서버가 확인한 오래된 일봉을 유지하며 자료 변경 실패는 이전 결과를 보존한다", async ({ app, page }) => {
  await prepare(app, page);
  const baseline = await execute(page);
  await app.restart({ clockStart: "20261107100000" });
  await page.reload();
  await openScreener(page);
  const holiday = await execute(page);
  expect(holiday.asOf).toBe("2026-11-06");
  expect(holiday.missingSummary).toBe(0);
  expect(holiday.rows.every((r) => !r.provisional)).toBe(true);
  const original = await meta(page).textContent();
  const bad = summaries(baseline, baseline.rows.find((r) => r.symbol === "110010")!.close);
  for (const row of bad) row.dt = "20261107";
  await quotes(app, bad);
  const rejected = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/screener/run");
  await runButton(page).click();
  const response = await rejected;
  expect(response.status()).toBe(409);
  expect((await response.json()).error.reason).toBe("data_changed");
  await expect(panel(page).getByRole("alert")).toContainText("자료가 바뀌었습니다");
  await expect(meta(page)).toHaveText(original!);
});

test("중간 배치 실패는 이전 결과가 없으면 빈 상태, 있으면 이전 수집 범위 그대로 남는다", async ({ app, page }) => {
  test.setTimeout(180_000);
  await app.fake.setKrxMarket("20261106", { extraStocks: 91 });
  await app.restart();
  await prepare(app, page, openScreener, false);
  const calls = async () => (await app.fake.stats()).apiIds.filter((id) => id === "ka10095").length;
  const collected: ScreenerResult = await (await fetch(`${app.url}/api/screener/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(screen) })).json();
  const firstBatch = collected.rows.slice(0, 100).map((r) => ({ stk_cd: r.symbol, dt: "20261106", cntr_tm: "195959", base_pric: String(r.close), cur_prc: String(r.close), open_pric: String(r.close), high_pric: String(r.close), low_pric: String(r.close), trde_qty: "1000", trde_prica: "100" }));
  const script = () => app.fake.script("ka10095", [
    { apiId: "ka10095", status: 200, body: { return_code: 0, atn_stk_infr: firstBatch } }, fail,
  ]);
  await script();
  const firstCount = await calls();
  await runButton(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("결과 없음");
  expect(await calls() - firstCount).toBe(2);
  await expect(results(page)).toHaveCount(0);
  const success = await execute(page);
  expect(success.universe).toBe(101);
  expect(success.rows).toHaveLength(101);
  const original = await meta(page).textContent();
  await script();
  const secondCount = await calls();
  await runButton(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("이전 결과와 수집 시각을 유지합니다");
  expect(await calls() - secondCount).toBe(2);
  await expect(meta(page)).toHaveText(original!);
  await expect(rows(page)).toHaveCount(101);
});

for (const olderFails of [false, true]) {
  test(`범위를 바꾸고 다른 화면을 다녀온 최신 결과는 뒤늦은 ${olderFails ? "실패" : "성공"}으로 바뀌지 않는다`, async ({ app, page }) => {
    await prepare(app, page);
    if (olderFails) await app.fake.respondWith(fail);
    let received!: () => void;
    let release!: () => void;
    const requested = new Promise<void>((r) => { received = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    await page.route("**/api/screener/run", async (route) => {
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch();
      received();
      await gate;
      await route.fulfill({ response });
    });
    await runButton(page).click();
    await requested;
    await app.fake.reset();
    await editRange(page, "M", 1, 1);
    const newest = await execute(page);
    const row = newest.rows.find((r) => r.symbol === "110010")!;
    expect(row.matchedDate).toBe("2026-10-01");
    const original = await meta(page).textContent();
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "스크리너", exact: true }).click();
    const delivered = page.waitForEvent("requestfinished", (r) => new URL(r.url()).pathname === "/api/screener/run");
    release();
    await delivered;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(meta(page)).toHaveText(original!);
    await expect(rows(page).filter({ hasText: "110010" }).locator('[title="첫 봉 조건 일치 2026-10-01"]')).toBeVisible();
    await expect(panel(page).getByRole("alert")).toHaveCount(0);
  });
}
