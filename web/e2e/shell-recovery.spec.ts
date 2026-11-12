import { cell, chartOf, expect, test } from "./harness";

for (const initialFailure of [true, false]) {
  test(initialFailure ? "처음 연 거래소 조회가 실패해도 범례에서 다른 거래소로 복구한다" : "거래소를 바꾼 뒤 조회가 실패해도 범례에서 다른 거래소로 복구한다", async ({ page }, info) => {
    await page.route("**/api/bars?*", (route) => new URL(route.request().url()).searchParams.get("venue") === "krx"
      ? route.fulfill({ status: 503, json: { error: { code: "kiwoom_unavailable", message: "시험용 KRX 조회 실패" } } })
      : route.continue());
    await page.goto(initialFailure ? "/?symbol=005930&venue=krx" : "/?symbol=005930");
    const venues = cell(page).getByRole("group", { name: "거래소", exact: true });
    if (!initialFailure) {
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
      await venues.getByRole("button", { name: "KRX", exact: true }).click();
    }
    await expect(cell(page).getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
    await expect(venues.getByRole("button", { name: "KRX", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(cell(page).getByText("삼성전자", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("venue-error.png") });
    await venues.getByRole("button", { name: "통합", exact: true }).click({ timeout: 3000 });
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(cell(page).getByRole("button", { name: "다시 시도", exact: true })).toHaveCount(0);
    await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
  });
}

test("긴 ETF 이름과 넓은 오른쪽 패널에서도 거래소가 차트 안에 있고 탭을 누를 수 있다", async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/?symbol=0000D0");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(cell(page)).toHaveAttribute("aria-label", /TIGER 엔비디아미국채커버드콜밸런스\(합성\)/);
  await page.getByRole("button", { name: "넓게 보기", exact: true }).click();
  const tabs = page.getByRole("tablist", { name: "오른쪽 패널" });
  await tabs.getByRole("tab", { name: /^스크리너/ }).click({ timeout: 3000 });
  const watch = tabs.getByRole("tab", { name: "관심종목", exact: true });
  const watchBox = await watch.boundingBox();
  if (!watchBox) throw new Error("관심종목 탭이 없습니다");
  await page.mouse.click(watchBox.x + watchBox.width / 2, watchBox.y + watchBox.height / 2);
  await expect(watch).toHaveAttribute("aria-selected", "true");
  const chartBox = await cell(page).boundingBox();
  if (!chartBox) throw new Error("차트가 없습니다");
  for (const button of await cell(page).getByRole("group", { name: "거래소", exact: true }).getByRole("button").all()) {
    const box = await button.boundingBox();
    if (!box) throw new Error("거래소 버튼이 없습니다");
    expect(box.x).toBeGreaterThanOrEqual(chartBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(chartBox.x + chartBox.width);
  }
  const name = cell(page).getByText("TIGER 엔비디아미국채커버드콜밸런스(합성)", { exact: true });
  await expect(name).toHaveAttribute("title", "TIGER 엔비디아미국채커버드콜밸런스(합성)");
  expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("long-etf-wide.png") });
});

