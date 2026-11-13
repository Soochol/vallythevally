import { financialTest as test, seedFinancialLayout, openFinancials, financialUpdatePage, expect } from "./financial-update-helpers";
import { cell, chartOf } from "./harness";

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) test.describe(`${viewport.width} 자동 재무자료 통합`, () => {
  const phone = viewport.width < 768;
  test.use({ viewport, isMobile: phone, hasTouch: phone });
  test("자동 확인·정정·일시정지·새로고침·재개의 표시가 지표와 가격을 유지한다", async ({ page, scenario, financial }, info) => {
    seedFinancialLayout(scenario);
    const next = Date.parse("2017-01-02T07:00:00+09:00") / 1000;
    financial.job(financialUpdatePage({ id: 1, automatic: true, nextCheckAt: next }));
    financial.onCommand(action => {
      if (action === "pause") financial.job({ status: "pausing", stopReason: "user", nextCheckAt: null, canResume: true });
      if (action === "resume") financial.job(financialUpdatePage({ id: 1, automatic: true, nextCheckAt: next + 2 * 86400, lastCheckedAt: next + 86400 }));
    });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const dialog = await openFinancials(page);
    await expect(dialog).toContainText("전체 이력 확인 완료");
    await expect(dialog).toContainText("다음 자동 확인");
    await expect(dialog).toContainText("2017. 1. 2. 오전 7:00:00");
    await page.screenshot({ path: info.outputPath("automatic-first-ready.png") });
    financial.job({ status: "collecting", phase: "recent", historyComplete: false });
    await page.reload();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    expect(Number(await chartOf(cell(page)).getAttribute("data-bar-count"))).toBeGreaterThan(0);
    await openFinancials(page);
    await dialog.getByRole("button", { name: "일시정지", exact: true }).click();
    await expect(dialog).toContainText("일시정지 처리 중");
    financial.job({ status: "paused" });
    await expect(dialog).toContainText("일시정지됨");
    await page.screenshot({ path: info.outputPath("automatic-user-paused.png") });
    await page.reload();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await openFinancials(page);
    await expect(dialog).toContainText("일시정지됨");
    await dialog.getByRole("button", { name: "재개", exact: true }).click();
    await expect(dialog).toContainText("전체 이력 확인 완료");
    await expect(dialog).toContainText("2017. 1. 4. 오전 7:00:00");
    await page.screenshot({ path: info.outputPath("automatic-correction-ready.png") });
    await dialog.getByRole("button", { name: "닫기", exact: true }).first().click();
    await expect(page.locator('[data-indicator-row="revenue"]')).toContainText("확인 완료");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  });
});
