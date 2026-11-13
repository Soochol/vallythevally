import type { Route } from "@playwright/test";
import { cell, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

const LAYOUT_PUT = `**/api/layouts/${DEFAULT_LAYOUT_ID}`;

test("앞 저장이 끝나기 전에 탭을 닫아도 마지막 편집이 남는다", async ({ scenario, browser, context, page, baseURL }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
  await expect(page.getByRole("contentinfo").getByText(/자동 저장됨/)).toBeVisible();
  const periods = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" });

  let held: Route | undefined;
  const firstPutHeld = new Promise<void>((resolve) => {
    void page.route(LAYOUT_PUT, async (route) => {
      if (route.request().method() !== "PUT" || held) return route.fallback();
      held = route;
      resolve();
    });
  });
  await periods.getByRole("button", { name: "주", exact: true }).click();
  await firstPutHeld;
  await periods.getByRole("button", { name: "월", exact: true }).click();
  await page.close();

  const serverPeriod = () => scenario.documents.layout(DEFAULT_LAYOUT_ID).cells[0]?.period;
  await expect.poll(serverPeriod).toBe("M");

  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(cell(reopened)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 월");


  const fresh = await browser.newContext({ baseURL });
  await scenario.install(fresh);
  const afterRestart = await fresh.newPage();
  await afterRestart.goto("/");
  await expect(cell(afterRestart)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 월");
  await fresh.close();
});
