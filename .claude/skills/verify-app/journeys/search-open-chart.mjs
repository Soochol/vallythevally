// Feature: features/search-open-chart.md. Search by 초성, open the symbol in cell 1, prove the chart loaded and the layout saved.
export default async function (page, { expect, api, screenshot }) {
  const cell = page.getByRole("region", { name: /^칸 1: / });
  const chart = cell.locator("[data-bar-count]");

  await page.goto("/");
  await expect(chart).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  const before = await cell.getAttribute("aria-label");
  await screenshot("start");

  await page.getByTitle("종목 검색 (/ 또는 Ctrl+K)").click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("ㅇㅋㅍㄹ");
  const option = dialog.getByRole("option").filter({ hasText: "086520" });
  await expect(option).toHaveAttribute("aria-disabled", "false");
  await screenshot("search-results");

  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/layouts/") && r.ok());
  await option.click();
  await expect(cell).toHaveAttribute("aria-label", "칸 1: 에코프로 통합 일");
  await expect(chart).toHaveAttribute("data-bar-count", "500");
  await saved;
  await screenshot("opened");

  const layouts = JSON.stringify(await api("/api/layouts/01900000-0000-7000-8000-000000000001"));
  expect(layouts).toContain("086520");

  await page.reload();
  await expect(cell).toHaveAttribute("aria-label", "칸 1: 에코프로 통합 일");
  await expect(chart).toHaveAttribute("data-bar-count", "500");
  await screenshot("after-reload");

  return { before, after: await cell.getAttribute("aria-label"), bars: Number(await chart.getAttribute("data-bar-count")), layoutHasSymbol: layouts.includes("086520") };
}
