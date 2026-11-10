const LAYOUT = "/api/layouts/01900000-0000-7000-8000-000000000001";
export default async function (page, { expect, api, screenshot }) {
  const cell = page.getByRole("region", { name: /^칸 1: / });
  const chart = cell.locator("[data-bar-count]");
  await page.goto("/?symbol=005930");
  await expect(chart).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  const row = page.locator("[data-indicator-row]");
  await expect(row).toHaveCount(1);
  await expect.poll(async () => (await api(LAYOUT)).cells[0].chartSettings.v).toBe(2);
  const before = (await api(LAYOUT)).cells[0].chartSettings.panels[0].stretch;

  const box = await chart.boundingBox();
  const top = await row.evaluate((el) => el.getBoundingClientRect().top);
  const sepY = top - 4;
  await page.mouse.move(box.x + box.width * 0.4, sepY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, sepY - 120, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await api(LAYOUT)).cells[0].chartSettings.panels[0].stretch, { timeout: 5000 }).toBeGreaterThan(before);
  const after = (await api(LAYOUT)).cells[0].chartSettings.panels[0].stretch;
  await screenshot("dragged-panel");

  await page.reload();
  await expect(chart).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await expect(row).toHaveCount(1);
  const top2 = await row.evaluate((el) => el.getBoundingClientRect().top);
  await screenshot("after-reload");

  await row.hover();
  await page.getByRole("button", { name: "거래량 패널 닫기" }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await api(LAYOUT)).cells[0].chartSettings.indicators.length).toBe(0);
  await page.reload();
  await expect(chart).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await page.waitForTimeout(500);
  await expect(row).toHaveCount(0);
  await screenshot("volume-removed-after-reload");
  return { before, after, topBefore: top, topAfterReload: top2 };
}
