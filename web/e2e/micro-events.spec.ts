import { cell, expect, test } from "./harness";
import { useCenterIndicatorWindow } from "./indicator-window";
import { openOrderWindow, ordersOn, tradingApi, win } from "./order-window";

test.describe("허수 취소·아이스버그 미시 신호", () => {
  test.use({ clockStart: "20261109100000" });

  test.beforeEach(async ({ page, scenario }) => {
    await page.clock.setFixedTime(new Date(scenario.now));
  });

  test("호가주문창 하단 총잔량 띠에는 비율 막대와 OFI 막대가 보이지 않는다", async ({ page, scenario }) => {
    ordersOn(scenario);
    tradingApi(scenario);
    await openOrderWindow(page, scenario);

    await expect(win(page).getByTestId("order-total-ask")).toBeVisible();
    await expect(win(page).getByTestId("order-total-bid")).toBeVisible();
    await expect(win(page).locator(".mw-ratio")).toHaveCount(0);
    await expect(win(page).getByTestId("order-ofi-bar")).toHaveCount(0);
  });

  test("차트 호가 잔량 히트맵 설정에 허수·아이스버그 토글과 미시 표기 방식이 보인다", async ({ page, scenario }) => {
    useCenterIndicatorWindow(scenario);
    scenario.reply(
      (url) => /^\/api\/symbols\/[^/]+\/quote-depth$/.test(url.pathname),
      { body: { available: true, venue: "combined", source: "priceMax", days: [{ date: "2026-11-09", state: "closed" }], points: [] } },
    );
    await page.goto("/?symbol=005930&period=5m");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");

    await page.getByRole("button", { name: /^지표/ }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "지표 추가", exact: true }).click();
    await dialog.getByRole("option", { name: "호가 잔량 히트맵 추가 후보", exact: true }).click();
    await dialog.getByRole("button", { name: "입력창 닫기", exact: true }).click();

    const heatRow = page.locator("[data-indicator-row]").filter({ hasText: "호가 잔량 히트맵" });
    await expect(heatRow).toHaveCount(1);
    await heatRow.getByRole("button", { name: "호가 잔량 히트맵 설정 열기", exact: true }).click();

    const spoofSwitch = dialog.getByRole("switch", { name: "허수 취소 표시", exact: true });
    const icebergSwitch = dialog.getByRole("switch", { name: "아이스버그 흡수 표시", exact: true });
    const modeGroup = dialog.getByRole("group", { name: "미시 표기 방식", exact: true });

    await expect(spoofSwitch).toHaveAttribute("aria-checked", "false");
    await expect(icebergSwitch).toHaveAttribute("aria-checked", "false");
    await expect(modeGroup.getByRole("button", { name: "점 표기", exact: true })).toHaveAttribute("aria-pressed", "true");

    await spoofSwitch.click();
    await icebergSwitch.click();
    await modeGroup.getByRole("button", { name: "배지 표기", exact: true }).click();

    await expect(spoofSwitch).toHaveAttribute("aria-checked", "true");
    await expect(icebergSwitch).toHaveAttribute("aria-checked", "true");
    await expect(modeGroup.getByRole("button", { name: "배지 표기", exact: true })).toHaveAttribute("aria-pressed", "true");

    await dialog.getByRole("button", { name: "설정 닫기", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
});
