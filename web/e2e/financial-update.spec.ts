import type { Locator, Page } from "@playwright/test";
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
    await dialog.getByRole("button", { name: "자세히", exact: true }).click();
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

test.describe("1440 재무자료 버튼과 상태 창", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const button = (page: Page) => page.getByRole("button", { name: "재무자료", exact: true }).filter({ visible: true });
  const colorsOf = (target: Locator) => target.evaluate((node) => ({ dot: getComputedStyle(node.querySelector("[data-financial-dot]")!).backgroundColor, text: getComputedStyle(node.querySelector("[data-financial-state]")!).color }));

  test("수집을 한 적이 없는 상태의 버튼에는 점도 상태 글자도 없다", async ({ page, scenario }) => {
    seedFinancialLayout(scenario);
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(button(page)).toBeVisible();
    await expect(button(page)).toHaveAttribute("data-tone", "idle");
    await expect(button(page).locator("[data-financial-dot], [data-financial-state]")).toHaveCount(0);
    await expect(button(page)).toHaveText("재무자료");
  });

  test("인증 오류로 멈춘 버튼과 사용자가 일시정지한 버튼은 글자와 점 색이 다르다", async ({ page, scenario, financial }) => {
    seedFinancialLayout(scenario);
    financial.job({ id: 1, status: "paused", phase: "recent", stopReason: "user", canResume: true, completedCompanies: 1 });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(button(page)).toContainText("멈춤");
    const paused = await colorsOf(button(page));
    financial.job({ status: "stopped", stopReason: "authentication", failure: "authentication" });
    await page.reload();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(button(page)).toContainText("확인 필요");
    const stopped = await colorsOf(button(page));
    expect(stopped.dot).not.toBe(paused.dot);
    expect(stopped.text).not.toBe(paused.text);
    expect(stopped.dot).toBe("rgb(255, 133, 82)");
    expect(paused.dot).toBe("rgb(235, 192, 116)");
  });

  test("상태 창의 진행 막대는 직접 그린 막대이고 진행에 따라 값이 커진다", async ({ page, scenario, financial }) => {
    seedFinancialLayout(scenario);
    financial.job({ id: 1, status: "collecting", phase: "recent", totalCompanies: 10, completedCompanies: 2, historyCompletedCompanies: 0, historyComplete: false });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const dialog = await openFinancials(page);
    const bar = dialog.getByRole("progressbar", { name: "재무 업데이트 진행률" });
    await expect(dialog.locator("progress")).toHaveCount(0);
    await expect(bar).toHaveAttribute("aria-valuenow", "10");
    expect((await bar.boundingBox())!.height).toBe(6);
    await expect(button(page)).toContainText("10%");
    const seen = [10];
    for (const [change, now] of [[{ completedCompanies: 6 }, 30], [{ completedCompanies: 10, phase: "history", historyCompletedCompanies: 0 }, 50], [{ historyCompletedCompanies: 5 }, 75]] as const) {
      financial.job(change);
      await expect(bar).toHaveAttribute("aria-valuenow", String(now));
      seen.push(now);
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    await expect(button(page)).toContainText("75%");
    await expect(bar.locator("[data-stage]")).toHaveCount(2);
  });

  test("인증 오류 창은 한 줄 문제와 한 줄 할 일 뒤에 시스템 설정 열기를 준다", async ({ page, scenario, financial }) => {
    seedFinancialLayout(scenario);
    financial.job({ id: 1, status: "stopped", phase: "recent", stopReason: "authentication", failure: "authentication", canResume: true });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const dialog = await openFinancials(page);
    await expect(dialog.getByText("DART 인증키를 확인해야 합니다", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "확인 후 재개", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "닫기", exact: true })).toHaveCount(1);
    await dialog.getByRole("button", { name: "시스템 설정 열기", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "시스템 설정", exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
  });

  test("상태 창이 열려도 재무자료 버튼은 가려지지 않는다", async ({ page, scenario, financial }) => {
    seedFinancialLayout(scenario);
    financial.job({ id: 1, status: "stopped", phase: "recent", stopReason: "authentication", failure: "authentication", canResume: true });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const dialog = await openFinancials(page);
    await expect(dialog.getByRole("status")).toBeVisible();
    const panel = (await dialog.boundingBox())!;
    for (const target of [button(page), page.getByRole("button", { name: "시스템 설정", exact: true }).filter({ visible: true })]) {
      const box = (await target.boundingBox())!;
      const overlaps = box.x < panel.x + panel.width && panel.x < box.x + box.width && box.y < panel.y + panel.height && panel.y < box.y + box.height;
      expect(overlaps).toBe(false);
    }
  });
});
