import { financialTest as test, seedFinancialLayout, openFinancials, financialUpdatePage, expect } from "./financial-update-helpers";
import { cell, chartOf } from "./harness";

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) test.describe(`${viewport.width} 과거 이력·일시정지`, () => {
  const phone = viewport.width < 768;
  test.use({ viewport, isMobile: phone, hasTouch: phone });
  test("최근 완료·과거 단계·일시정지·새로고침·재개 상태를 구분한다", async ({ page, scenario, financial }, info) => {
    seedFinancialLayout(scenario);
    financial.onCommand(action => {
      if (action === "start") financial.job({ id: 1, status: "collecting", phase: "recent", completedCompanies: 2, historyCompletedCompanies: 0, historyComplete: false, throughYear: 2020 });
      if (action === "pause") financial.job({ status: "pausing", stopReason: "user", canResume: true });
      if (action === "resume") financial.job(financialUpdatePage({ id: 1, throughYear: 2020 }));
    });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const dialog = await openFinancials(page);
    await dialog.getByRole("button", { name: "전체 업데이트", exact: true }).click();
    await expect(dialog).toContainText("최근 자료 수집 중");
    financial.job({ phase: "history", historyCompletedCompanies: 1 });
    await expect(dialog).toContainText("과거 이력 수집 중");
    await expect(dialog).toContainText("미완료");
    await dialog.getByRole("button", { name: "일시정지", exact: true }).click();
    await expect(dialog).toContainText("일시정지 처리 중");
    await expect(dialog).toContainText("사용자 요청");
    await page.screenshot({ path: info.outputPath("history-pausing.png") });
    financial.job({ status: "paused" });
    await expect(dialog).toContainText("일시정지됨");
    await page.reload();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await openFinancials(page);
    await expect(dialog).toContainText("일시정지됨");
    await expect(dialog).toContainText("사용자 요청");
    await dialog.getByRole("button", { name: "재개", exact: true }).click();
    await expect(dialog).toContainText("전체 이력 확인 완료");
    await expect(dialog).toContainText("2020");
    await page.screenshot({ path: info.outputPath("history-complete.png") });
    await dialog.getByRole("button", { name: "닫기", exact: true }).first().click();
    await expect(page.locator('[data-indicator-row="revenue"]')).toContainText("확인 완료");
    expect(Number(await chartOf(cell(page)).getAttribute("data-bar-count"))).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  });
});
