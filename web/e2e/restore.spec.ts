import { cell, expect, test } from "./harness";

test("바꾼 종목·거래소·봉 주기가 새로고침과 서버 재시작 뒤에도 남는다", async ({ app, page }) => {
  await page.goto("/?symbol=005930");
  const toolbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");

  await cell(page).getByRole("group", { name: "거래소" }).getByRole("button", { name: "NXT" }).click();
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/layouts/") && r.ok());
  await toolbar.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "주", exact: true }).click();
  await saved;
  await expect(page.getByRole("contentinfo").getByText(/자동 저장됨/)).toBeVisible();

  const expectRestored = async () => {
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 NXT 주");
    await expect(cell(page).getByRole("group", { name: "거래소" }).getByRole("button", { name: "NXT" })).toHaveAttribute("aria-pressed", "true");
    await expect(toolbar.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "주", exact: true })).toHaveAttribute("aria-pressed", "true");
  };
  await page.reload();
  await expectRestored();

  await app.restart();
  await page.reload();
  await expectRestored();
});
