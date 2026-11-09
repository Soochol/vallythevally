import { cell, chartOf, dragTowardPast, expect, test } from "./harness";

const AUTH_8050 = { return_code: 3, return_msg: "인증에 실패했습니다[8050:지정단말기 인증에 실패했습니다]" };
const RETRYABLE_WITHOUT_CLOSING_GATE = { return_code: 2, return_msg: "입력값 오류[1501:입력값을 확인하세요]" };

test("주소의 없는 종목은 알림으로 알리고 칸은 그대로 둔다", async ({ page }) => {
  await page.goto("/?symbol=999999");
  await expect(page.getByText("주소의 종목 999999를 찾을 수 없습니다")).toBeVisible();
  await expect(cell(page)).not.toHaveAttribute("aria-label", /999999/);
});

test.describe("키움이 [8050]으로 거절하면", () => {
  test.use({ bootReplies: [{ apiId: "au10001", status: 200, body: AUTH_8050 }] });

  test("상태 막대에 멈춤을 알리고 칸은 다시 시도 없이 이유를 보인다", async ({ page }) => {
    await page.goto("/");
    const stopped = page.getByRole("contentinfo").getByRole("alert");
    await expect(stopped).toContainText("키움 조회 멈춤:");
    await expect(stopped).toContainText("[8050]");
    const overlay = cell(page).getByRole("alert");
    await expect(overlay).toContainText("[8050]");
    await expect(overlay.getByRole("button", { name: "다시 시도" })).toHaveCount(0);
  });
});

test("과거 페이지를 받지 못하면 칸에 알리고, 다시 시도로 이어 받는다", async ({ app, page }) => {
  await page.goto("/?symbol=086520");
  const chart = chartOf(cell(page));
  await expect(chart).toHaveAttribute("data-bar-count", "500");

  await app.fake.respondWith({ apiId: "ka10081", status: 200, body: RETRYABLE_WITHOUT_CLOSING_GATE });
  const alert = cell(page).getByRole("alert");
  await dragTowardPast(page, chart, () => expect(alert).toContainText("과거 봉을 받지 못했습니다.", { timeout: 500 }));
  await expect(chart).toHaveAttribute("data-bar-count", "500");

  await app.fake.reset();
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect(chart).toHaveAttribute("data-bar-count", "1000");
  await expect(alert).toBeHidden();
});
