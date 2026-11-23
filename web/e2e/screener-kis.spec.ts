import { KIS_MARKET_SOURCE, KIS_SOURCE_KIWOOM_FEED } from "./fixtures/market-source";
import { readyStatus } from "./fixtures/screener";
import { expect, test } from "./screener-harness";
import { openScreener, results, rows, runButton, storeLine } from "./screener-page";

const REFUSAL = "스크리너 갱신은 연결된 키움 키가 있어야 합니다. 지금은 연결된 키움 키가 없습니다";
const NEW_HIGH = { kind: "new_high", period: "D", field: "close", n: 60, recentBars: 1 } as const;

test.describe("한투만 연결된 스크리너", () => {
  test.beforeEach(async ({ page, scenario, screener }) => {
    scenario.live.marketSource = KIS_MARKET_SOURCE;
    screener.showStatus(readyStatus());
    scenario.documents.saveScreens({ screens: [{ id: "high", name: "고점", markets: [], exclude: [], conditions: [NEW_HIGH] }], revision: 1 });
    await page.goto("/");
    await openScreener(page);
  });

  test("실행 단추가 눌리고 결과가 보인다", async ({ page }) => {
    await expect(runButton(page)).toBeEnabled();
    await runButton(page).click();
    await expect(results(page)).toHaveAttribute("aria-busy", "false");
    await expect(rows(page).first()).toBeVisible();
  });

  test("업데이트 단추는 꺼져 있고 키움 키가 필요하다고 알려 준다", async ({ page }) => {
    const update = storeLine(page).getByRole("button", { name: /^업데이트/ });
    await expect(update).toBeDisabled();
    await expect(update).toHaveAttribute("title", "키움 키가 있어야 갱신합니다");
  });

  test("업데이트 단추가 눌린 사이 서버가 거절하면 서버의 거절 문구가 보인다", async ({ page, scenario }) => {
    scenario.reply("/api/screener/update", { status: 400, body: { error: { code: "bad_request", message: REFUSAL, reason: "unsupported_by_source", retryAt: null, manualActionRequired: false } } });
    const update = storeLine(page).getByRole("button", { name: /^업데이트/ });
    scenario.live.source(KIS_SOURCE_KIWOOM_FEED);
    await expect(update).toBeEnabled();
    await update.click();
    await expect(page.locator(".ui-toast")).toContainText(REFUSAL);
  });
});
