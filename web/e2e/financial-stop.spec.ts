import { financialTest as test, openFinancials, financialUpdatePage, expect } from "./financial-update-helpers";
import { cell, chartOf } from "./frontend-harness";

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) test.describe(`${viewport.width} 인증·한도 정지`, () => {
  const phone = viewport.width < 768;
  test.use({ viewport, isMobile: phone, hasTouch: phone });
  for (const failure of [{ reason: "authentication", text: "인증 오류" }, { reason: "rate_limited", text: "호출 한도" }] as const) test(`${failure.reason} 정지 안내와 확인 중·재개 결과를 표시한다`, async ({ page, financial }, info) => {
    let allowed = false;
    financial.onCommand(action => {
      if (action === "resume" && allowed) financial.job(financialUpdatePage({ id: 1 }));
      else if (action === "resume") financial.job({ status: "checking", canResume: false });
      else financial.job({ id: 1, status: "stopped", phase: "recent", stopReason: failure.reason, failure: failure.reason, canResume: true, nextCheckAt: failure.reason === "rate_limited" ? Date.parse("2016-01-02T07:00:00+09:00") / 1000 : null });
    });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const dialog = await openFinancials(page);
    await dialog.getByRole("button", { name: "전체 업데이트", exact: true }).click();
    await expect(dialog).toContainText("재무자료 수집 정지");
    await expect(dialog).toContainText(failure.text);
    if (failure.reason === "rate_limited") await expect(dialog).toContainText("2016. 1. 2. 오전 7:00:00");
    await page.screenshot({ path: info.outputPath(`${failure.reason}-stopped.png`) });
    await page.reload();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await openFinancials(page);
    await expect(dialog).toContainText(failure.text);
    await dialog.getByRole("button", { name: "확인 후 재개", exact: true }).click();
    await expect(dialog).toContainText("재개 확인 중");
    await expect(dialog.getByRole("button", { name: "확인 중", exact: true })).toBeDisabled();
    financial.job({ status: "stopped", canResume: true });
    await expect(dialog).toContainText("재무자료 수집 정지");
    allowed = true;
    await dialog.getByRole("button", { name: "확인 후 재개", exact: true }).click();
    await expect(dialog).toContainText("전체 이력 확인 완료");
    expect(await dialog.innerText()).not.toContain("SYNTHETIC-DART-E2E");
    await page.screenshot({ path: info.outputPath(`${failure.reason}-resumed.png`) });
    await dialog.getByRole("button", { name: "닫기", exact: true }).first().click();
    expect(Number(await chartOf(cell(page)).getAttribute("data-bar-count"))).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  });
});
