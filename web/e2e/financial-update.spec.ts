import { financialTest as test, seedFinancialLayout, openFinancials, financialUpdatePage, expect } from "./financial-update-helpers";
import { cell, chartOf } from "./harness";

for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) test.describe(`${size.width} 재무자료 공통 창`, () => {
  const phone = size.width < 768;
  test.use({ viewport: size, isMobile: phone, hasTouch: phone });
  test("저장 조회·진행·중단 안내와 재개·차트·스크리너 진입점", async ({ page, scenario, financial }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    seedFinancialLayout(scenario);
    financial.show("ready", { status: "not_collected", series: [] });
    let failNext = false;
    financial.onCommand(action => {
      if (action === "resume") { financial.show(); financial.job(financialUpdatePage({ id: 1 })); }
      else if (failNext) financial.job(financialUpdatePage({ id: 2, status: "partial_failure", historyComplete: false, completedCompanies: 1, failedCompanies: 1, failures: [{ code: "00126380", name: "삼성전자", reason: null, failure: "remote" }] }));
      else { financial.show("ready", { status: "collecting" }); financial.job({ id: 1, status: "collecting", phase: "recent", completedCompanies: 1, historyComplete: false }); }
    });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const row = page.locator('[data-indicator-row="revenue"]');
    await expect(row).toContainText("미수집");
    let dialog = await openFinancials(page);
    await expect(dialog).toContainText("업데이트 전");
    await dialog.getByRole("button", { name: "전체 업데이트", exact: true }).click();
    await expect(dialog).toContainText("1 / 2회사");
    await expect(dialog.getByRole("button", { name: "일시정지", exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath("financial-update-progress.png") });
    financial.job({ status: "interrupted", stopReason: "interrupted", canResume: true });
    await page.reload();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    dialog = await openFinancials(page);
    await expect(dialog).toContainText("중단된 작업 있음");
    await expect(dialog).toContainText("2015~2017");
    await dialog.getByRole("button", { name: "이어서 업데이트", exact: true }).click();
    await expect(dialog).toContainText("전체 이력 확인 완료");
    await expect(dialog).toContainText("2 / 2회사");
    await expect(dialog).toContainText("배당 주식 종류 미확인");
    await page.screenshot({ path: info.outputPath("financial-update-ready.png") });
    await dialog.getByRole("button", { name: "닫기", exact: true }).first().click();
    await expect(row).toContainText("확인 완료");
    await row.locator("summary").click();
    await row.getByRole("button", { name: "전체 재무자료 업데이트", exact: true }).click();
    await expect(dialog).toContainText("2 / 2회사");
    await dialog.getByRole("button", { name: "닫기", exact: true }).first().click();
    await page.keyboard.press("Escape");
    if (phone) await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "스크리너", exact: true }).click();
    else await page.getByRole("tab", { name: "스크리너", exact: true }).click();
    const entry = phone ? page.getByRole("complementary", { name: "스크리너", exact: true }) : page.getByRole("toolbar");
    await entry.getByRole("button", { name: "재무자료", exact: true }).click();
    await expect(dialog).toContainText("2 / 2회사");
    failNext = true;
    await dialog.getByRole("button", { name: "전체 업데이트", exact: true }).click();
    await expect(dialog).toContainText("일부 자료 확인 실패");
    const failures = dialog.getByRole("region", { name: "실패·미확인 목록" });
    await expect(failures).toContainText("00126380");
    await expect(failures).toContainText("자료원 응답 오류");
    await page.screenshot({ path: info.outputPath("financial-update-failure.png") });
    expect(Number(await chartOf(cell(page)).getAttribute("data-bar-count"))).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
    expect(errors).toEqual([]);
  });
});
