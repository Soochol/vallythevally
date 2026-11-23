import { cell, chartOf, expect, test, pickDesktopVenue, expectDesktopVenue } from "./harness";

for (const initialFailure of [true, false]) {
  test(initialFailure ? "처음 연 거래소 조회가 실패해도 위 막대에서 다른 거래소로 복구한다" : "거래소를 바꾼 뒤 조회가 실패해도 위 막대에서 다른 거래소로 복구한다", async ({ page }, info) => {
    await page.route("**/api/bars?*", (route) => new URL(route.request().url()).searchParams.get("venue") === "krx"
      ? route.fulfill({ status: 503, json: { error: { code: "kiwoom_unavailable", message: "시험용 KRX 조회 실패" } } })
      : route.fallback());
    await page.goto(initialFailure ? "/?symbol=005930&venue=krx" : "/?symbol=005930");
    if (!initialFailure) {
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
      await pickDesktopVenue(page, "KRX");
    }
    await expect(cell(page).getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
    await expectDesktopVenue(page, "KRX");
    await expect(cell(page).getByText("삼성전자", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("venue-error.png") });
    await pickDesktopVenue(page, "통합");
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(cell(page).getByRole("button", { name: "다시 시도", exact: true })).toHaveCount(0);
    await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
  });
}

const LONG_NAME = "TIGER 엔비디아미국채커버드콜밸런스(합성) 장기 보유 목적 포트폴리오 시험 종목";

test("긴 ETF 이름은 범례에서 잘리고 탭을 누를 수 있다", async ({ page, scenario }, info) => {
  scenario.reply("/api/symbols/0000D0", { body: { code: "0000D0", name: LONG_NAME, kind: "etf", market: "kospi", nxtEnabled: false } });
  await page.setViewportSize({ width: 800, height: 768 });
  await page.goto("/?symbol=0000D0");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(cell(page)).toHaveAttribute("aria-label", /TIGER 엔비디아미국채커버드콜밸런스\(합성\) 장기 보유/);
  const tabs = page.getByRole("tablist", { name: "창 묶음 2" });
  await tabs.getByRole("tab", { name: /^스크리너/ }).click({ timeout: 3000 });
  const watch = tabs.getByRole("tab", { name: "관심종목", exact: true });
  await watch.click();
  await expect(watch).toHaveAttribute("aria-selected", "true");
  const chartBox = await cell(page).boundingBox();
  if (!chartBox) throw new Error("차트가 없습니다");
  const heading = cell(page).getByRole("heading", { name: LONG_NAME, exact: true });
  const headingBox = await heading.boundingBox();
  if (!headingBox) throw new Error("범례 이름이 없습니다");
  expect(headingBox.x + headingBox.width).toBeLessThanOrEqual(chartBox.x + chartBox.width);
  const name = cell(page).getByText(LONG_NAME, { exact: true });
  await expect(name).toHaveAttribute("aria-label", LONG_NAME);
  expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("long-etf.png") });
});
