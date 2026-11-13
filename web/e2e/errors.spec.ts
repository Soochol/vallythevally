import type { ApiError } from "../src/api/generated/ApiError";
import { cell, chartOf, dragTowardPast, expect, test } from "./harness";

const stopped: ApiError = { error: { code: "kiwoom_auth_failed", message: "인증에 실패했습니다 [8050] 지정단말기 인증에 실패했습니다", reason: "auth_blocked", retryAt: null, manualActionRequired: true } };

test("주소의 없는 종목은 알림으로 알리고 칸은 그대로 둔다", async ({ page }) => {
  await page.goto("/?symbol=999999");
  await expect(page.getByText("주소의 종목 999999를 찾을 수 없습니다")).toBeVisible();
  await expect(cell(page)).not.toHaveAttribute("aria-label", /999999/);
});

test("인증 중단 응답은 상태 막대와 칸에 이유를 보이고 다시 시도를 감춘다", async ({ page, scenario }) => {
  scenario.reply("/api/bars", { status: 503, body: stopped });
  await page.goto("/");
  const status = page.getByRole("contentinfo").getByRole("alert");
  await expect(status).toContainText("[8050]");
  const overlay = cell(page).getByRole("alert");
  await expect(overlay).toContainText("[8050]");
  await expect(overlay.getByRole("button", { name: "다시 시도" })).toHaveCount(0);
});

test("과거 페이지를 받지 못하면 칸에 알리고, 다시 시도로 이어 받는다", async ({ scenario, page }) => {
  let failed = true;
  scenario.on((url) => url.pathname === "/api/bars" && url.searchParams.has("before"), request => failed
    ? { status: 503, body: { error: { code: "kiwoom_unavailable", message: "과거 자료 조회 실패", reason: null, retryAt: null, manualActionRequired: false } } }
    : { body: scenario.market.page({ symbol: "086520", before: Number(new URL(request.url()).searchParams.get("before")) }) });
  await page.goto("/?symbol=086520");
  const chart = chartOf(cell(page));
  await expect(chart).toHaveAttribute("data-bar-count", "500");
  const alert = cell(page).getByRole("alert");
  await dragTowardPast(page, chart, () => expect(alert).toContainText("과거 봉을 받지 못했습니다.", { timeout: 500 }));
  await expect(chart).toHaveAttribute("data-bar-count", "500");
  failed = false;
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect(chart).toHaveAttribute("data-bar-count", "1000");
  await expect(alert).toBeHidden();
});
