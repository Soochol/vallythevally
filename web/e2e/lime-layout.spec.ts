import { selectMinute } from "./select-option";
import { cell, expect, test } from "./harness";

test.use({ clockStart: "20261109100030" });

test("라이트 저장값도 라임 다크로 열고 분봉은 하나의 메뉴이며 작은 창에서 도구가 페이지를 넘기지 않는다", async ({ scenario, page }, info) => {
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, theme: "light", revision: state.revision + 1 });
  await page.addInitScript(() => localStorage.setItem("vv.theme", "light"));
  const asked: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/fundamentals")) asked.push(r.url()); });
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "테마 바꾸기" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "종목 정보" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1분", exact: true })).toHaveCount(0);
  await selectMinute(page.getByRole("button", { name: "분봉", exact: true }), "10m");
  await expect(cell(page)).toHaveAttribute("aria-label", /10분/);
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 768, height: 300 }]) {
    await page.setViewportSize(size);
    await expect.poll(() => page.evaluate(() => ({ width: document.documentElement.scrollWidth - innerWidth, height: document.documentElement.scrollHeight - innerHeight }))).toEqual({ width: 0, height: 0 });
    const help = page.getByRole("button", { name: "드로잉 단축키 도움말", exact: true });
    await help.scrollIntoViewIfNeeded();
    await help.click();
    await expect(page.getByRole("dialog", { name: "드로잉 단축키", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "도움말 닫기", exact: true }).click();
    const tools = page.getByLabel("선 도구 펼치기", { exact: true });
    await tools.scrollIntoViewIfNeeded();
    await tools.click();
    await expect(page.getByRole("menu", { name: "선 도구", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "선 도구", exact: true })).toBeHidden();
  }
  expect(asked).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: info.outputPath("chart.png"), fullPage: true });
});
