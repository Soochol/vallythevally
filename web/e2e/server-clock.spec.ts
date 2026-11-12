import { cell, expect, test } from "./harness";

for (const [serverTime, browserTime, market, connection] of [
  ["2026-11-12T10:00:00+09:00", "2026-11-12T03:00:00+09:00", "장중", "실시간 연결됨"],
  ["2026-11-12T22:00:00+09:00", "2026-11-12T10:00:00+09:00", "장 마감", "장 닫힘: 체결 없음"],
] satisfies readonly [string, string, string, string][]) {
  test(`브라우저 시계가 틀려도 서버 기준 ${market}과 연결 상태가 일치한다`, async ({ page }, info) => {
    await page.clock.setFixedTime(new Date(browserTime));
    await page.route("**/api/**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), date: new Date(serverTime).toUTCString() } });
    });
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const footer = page.locator("footer").last();
    await expect(footer.getByLabel("장 상태와 서버 시계")).toContainText(market);
    await expect(footer.getByRole("status")).toHaveText(connection);
    await page.screenshot({ path: info.outputPath("server-clock.png") });
  });
}
