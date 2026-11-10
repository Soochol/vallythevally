const LAYOUT = "/api/layouts/01900000-0000-7000-8000-000000000001";

const trade = (time, price) => ({ "20": time, "10": `+${price}`, "15": "+1", "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2" });

export default async function (page, { expect, api, fake, screenshot }) {
  const cell = page.getByRole("region", { name: /^칸 1: / });
  const chart = cell.locator("[data-bar-count]");
  const rows = cell.locator("[data-compare-row]");
  const row = (code) => cell.locator(`[data-compare-row="${code}"]`);
  const settings = async () => (await api(LAYOUT)).cells[0].chartSettings;

  await page.goto("/?symbol=005930");
  await expect(cell).toHaveAttribute("aria-busy", "false");
  await expect(chart).toHaveAttribute("data-price-scale", "normal");

  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "지표" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: "볼린저 밴드" }).click();
  await dialog.getByRole("button", { name: "볼린저 밴드 20 2 추가" }).click();
  await screenshot("start-bollinger-normal-axis");

  await dialog.getByRole("tab", { name: "비교 종목" }).click();
  const search = dialog.getByRole("combobox", { name: "비교할 종목 찾기" });
  for (const name of ["삼성SDI", "삼성화재", "코스피"]) {
    await search.fill(name);
    await dialog.getByRole("option", { name: new RegExp(name) }).first().click();
    await dialog.getByRole("button", { name: new RegExp(`^${name}.*추가$`) }).click();
  }
  await search.fill("삼성물산");
  await dialog.getByRole("option", { name: /삼성물산/ }).first().click();
  await expect(dialog.getByRole("button", { name: /^삼성물산.*추가$/ })).toBeDisabled();
  await expect(dialog).toContainText("비교 종목은 3개까지입니다");
  await expect(dialog.getByRole("switch", { name: "가격축을 % 변화로" })).toBeDisabled();
  await screenshot("dialog-three-compares-fourth-refused");

  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(3);
  await expect(chart).toHaveAttribute("data-price-scale", "percent");
  for (const code of ["006400", "000810", "IDX:001"]) await expect(row(code)).not.toHaveAttribute("data-last-t", "");
  await expect.poll(async () => (await settings()).compare).toEqual(["006400", "000810", "IDX:001"]);
  const savedScale = (await settings()).scale;
  await screenshot("chart-percent-three-compares-bollinger");

  await expect.poll(async () => (await fake.registered())["0B"] ?? []).toEqual(expect.arrayContaining(["005930_AL", "006400_AL", "000810_AL"]));
  const registered = await fake.registered();

  await expect(async () => {
    await fake.pushReal("0B", "005930_AL", trade("100001", 194_000));
    await expect(chart).toHaveAttribute("data-last-close", "194000", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  const before = { sdi: await row("006400").getAttribute("data-last-close"), fire: await row("000810").getAttribute("data-last-close") };
  for (const [code, time, price] of [["006400", "100002", 196_500], ["000810", "100003", 190_000]]) {
    await expect(async () => {
      await fake.pushReal("0B", `${code}_AL`, trade(time, price));
      await expect(row(code)).toHaveAttribute("data-last-close", String(price), { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  }
  const legendLive = await cell.locator("[data-compare-row]").allInnerTexts();
  await screenshot("realtime-compares-moved");

  const box = await chart.boundingBox();
  const away = () => page.mouse.move(box.x + box.width + 60, box.y + 120);
  await away();
  const legendFullView = await rows.allInnerTexts();
  await expect(async () => {
    await page.mouse.move(box.x + box.width * 0.97, box.y + box.height * 0.5);
    await page.mouse.wheel(0, -400);
    await away();
    expect(await rows.allInnerTexts()).not.toEqual(legendFullView);
  }).toPass({ timeout: 20_000 });
  const legendZoomed = await rows.allInnerTexts();
  await screenshot("zoomed-left-edge-inside-data");
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await away();
  await expect.poll(() => rows.allInnerTexts()).not.toEqual(legendZoomed);
  const legendAfterScroll = await rows.allInnerTexts();
  await screenshot("after-scroll-new-left-edge-base");

  await page.reload();
  await expect(cell).toHaveAttribute("aria-busy", "false");
  await expect(rows).toHaveCount(3);
  await expect(chart).toHaveAttribute("data-price-scale", "percent");
  await screenshot("after-reload-settings-kept");

  for (const name of ["삼성SDI", "삼성화재", "코스피"]) {
    const r = rows.filter({ hasText: name });
    await r.hover();
    await page.getByRole("button", { name: `${name} 비교 종목 지우기` }).click();
  }
  await expect(rows).toHaveCount(0);
  await expect(chart).toHaveAttribute("data-price-scale", savedScale);
  await expect.poll(async () => (await settings()).compare).toEqual([]);

  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "%", exact: true }).click();
  await expect(chart).toHaveAttribute("data-price-scale", "percent");
  await expect.poll(async () => (await settings()).scale).toBe("percent");
  await screenshot("percent-axis-without-compares");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("tab", { name: "비교 종목" }).click();
  const phoneSwitch = sheet.getByRole("switch", { name: "가격축을 % 변화로" });
  await expect(phoneSwitch).toHaveAttribute("aria-checked", "true");
  await phoneSwitch.click();
  await expect(phoneSwitch).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await settings()).scale).toBe("normal");
  await screenshot("phone-390-compare-tab-switch-off");
  await page.keyboard.press("Escape");
  await expect(chart).toHaveAttribute("data-price-scale", "normal");

  return { savedScale, registered, before, legendLive, legendFullView, legendZoomed, legendAfterScroll };
}
