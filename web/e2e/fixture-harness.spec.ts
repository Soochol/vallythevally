import { cell, chartOf, expect, test } from "./harness";

test("브라우저 시나리오에서 초성 검색한 종목의 차트를 연다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  await page.getByRole("combobox", { name: "종목 검색" }).fill("ㅅㅅ");
  const samsung = page.getByRole("option").filter({ hasText: "005930" });
  await expect(samsung).toHaveAttribute("aria-disabled", "false");
  await expect(samsung.getByLabel("현재가")).toHaveText(scenario.market.quote("005930")!.price.toLocaleString("ko-KR"));
  await samsung.click();
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
});

test("브라우저 시나리오는 자동 저장한 봉 주기를 새로고침 뒤 복원한다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "주", exact: true }).click();
  await expect.poll(() => scenario.documents.layout().cells[0]?.period).toBe("W");
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 주");
});

test("브라우저 시나리오의 실시간 봉이 차트에 반영된다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => scenario.live.subscriptions().some(value => value.symbol === "005930")).toBe(true);
  const current = scenario.market.page({ symbol: "005930" }).current!;
  scenario.live.bar("005930", { ...current, c: 202_000, h: 202_000 });
  await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "202000");
});
