import { expect, test } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });

test("차트 Topbar에 KST 시계와 장 상태가 표시되고 1초마다 갱신된다", async ({ page, scenario }) => {
  await page.clock.install({ time: scenario.now });
  await page.goto("/");
  const bar = page.getByRole("toolbar", { name: "차트 도구 막대" });
  const clock = bar.getByTestId("topbar-clock");
  await expect(clock).toBeVisible();
  await expect(clock.locator(".topbar-clock-time")).toHaveText("10:00:00");
  await expect(clock.locator(".topbar-clock-session")).toHaveText("정규장");
  await expect(clock).toHaveAttribute("data-session", "정규장");

  await page.clock.fastForward(1000);
  await expect(clock.locator(".topbar-clock-time")).toHaveText("10:00:01");
});

test("PageTopbar에 KST 시계가 표시되고 좁은 폭에서는 장 상태 라벨만 숨긴다", async ({ page, scenario }) => {
  await page.clock.install({ time: scenario.now });
  await page.goto("/market");
  const bar = page.getByRole("toolbar", { name: "페이지 도구 막대" });
  const clock = bar.getByTestId("topbar-clock");
  await expect(clock).toBeVisible();
  await expect(clock.locator(".topbar-clock-time")).toHaveText("10:00:00");
  await expect(clock.locator(".topbar-clock-session")).toBeVisible();

  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(clock.locator(".topbar-clock-time")).toBeVisible();
  await expect(clock.locator(".topbar-clock-session")).toBeHidden();
  const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
