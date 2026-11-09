import { barTimes, cell, chartOf, dragTowardPast, expect, SEARCH_BUTTON_TITLE, test } from "./harness";

test("초성으로 찾은 종목을 열고 과거로 끌면 과거 봉이 앞에 붙는다", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("ㅇㅋㅍㄹ");
  const ecopro = dialog.getByRole("option").filter({ hasText: "086520" });
  await expect(ecopro).toHaveAttribute("aria-disabled", "false");
  await ecopro.click();

  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 에코프로 통합 일");
  const chart = chartOf(cell(page));
  await expect(chart).toHaveAttribute("data-bar-count", "500");
  const latest = await barTimes(chart);

  await dragTowardPast(page, chart, () => expect(chart).toHaveAttribute("data-bar-count", "1000", { timeout: 500 }));
  const older = await barTimes(chart);
  expect(older.first).toBeLessThan(latest.first);

  await dragTowardPast(page, chart, () => expect(chart).toHaveAttribute("data-bar-count", "1200", { timeout: 500 }));
  const oldest = await barTimes(chart);
  expect(oldest.first).toBeLessThan(older.first);
});

test("검색어를 바꾼 뒤 새 결과가 오기 전에는 Enter가 이전 결과를 열지 않는다", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const isSecondQuery = (url: URL) => url.pathname === "/api/symbols" && url.searchParams.get("q") === "005930";
  await page.route(isSecondQuery, async (route) => {
    await held;
    await route.continue();
  });

  await page.goto("/");
  const before = await cell(page).getAttribute("aria-label");
  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  const input = dialog.getByRole("combobox", { name: "종목 검색" });
  await input.fill("ㅇㅋㅍㄹ");
  await expect(dialog.getByRole("option").filter({ hasText: "086520" })).toHaveAttribute("aria-disabled", "false");

  const secondSent = page.waitForRequest((r) => isSecondQuery(new URL(r.url())));
  await input.fill("005930");
  await secondSent;
  await input.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(cell(page)).toHaveAttribute("aria-label", before!);
  await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-disabled", "true");

  release();
  await expect(dialog.getByRole("option").filter({ hasText: "삼성전자" }).first()).toHaveAttribute("aria-disabled", "false");
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
});
