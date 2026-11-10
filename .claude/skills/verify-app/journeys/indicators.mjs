const LAYOUT = "/api/layouts/01900000-0000-7000-8000-000000000001";

function installSeriesProbe() {
  const series = new Set();
  const set = Map.prototype.set;
  Map.prototype.set = function (key, value) {
    if (key && typeof key === "object" && typeof key.seriesType === "function" && typeof key.data === "function") series.add(key);
    return set.call(this, key, value);
  };
  window.seriesProbe = () =>
    [...series].map((s) => ({ type: s.seriesType(), last: s.data().at(-1)?.time ?? null, count: s.data().length, visible: s.options().visible }));
}

export default async function (page, { expect, api, fake, screenshot }) {
  await page.addInitScript(installSeriesProbe);
  const cell = page.getByRole("region", { name: /^칸 1: / });
  const chart = cell.locator("[data-bar-count]");
  const rows = page.locator("[data-indicator-row]");
  const row = (name) => rows.filter({ hasText: name });

  await page.goto("/?symbol=086520");
  await expect(cell).toHaveAttribute("aria-busy", "false");
  await expect(rows).toHaveCount(1);
  await screenshot("start-default-volume");

  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "지표" }).click();
  const dialog = page.getByRole("dialog", { name: "지표 추가" });
  await expect(dialog).toBeVisible();
  const period = dialog.getByLabel("기간", { exact: true });
  for (const p of ["5", "20", "60", "120"]) {
    await period.fill(p);
    const add = dialog.getByRole("button", { name: `이동평균 단순 ${p} 추가` });
    await expect(add).toBeEnabled();
    await add.click();
  }
  for (const [kind, label] of [["볼린저 밴드", "볼린저 밴드 20 2 추가"], ["일목균형표", "일목균형표 9 26 52 26 추가"], ["RSI", "RSI 14 추가"], ["MACD", "MACD 12 26 9 추가"], ["스토캐스틱 슬로우", "스토캐스틱 슬로우 5 3 3 추가"]]) {
    await dialog.getByRole("option", { name: kind }).click();
    await dialog.getByRole("button", { name: label }).click();
  }
  await expect(dialog.getByRole("option", { name: /이동평균/ })).toContainText("4개 띄움");
  await dialog.getByRole("option", { name: "MACD" }).click();
  await dialog.getByLabel("느린 기간").fill("5");
  const macdError = dialog.getByText("fast보다 커야 합니다.");
  await expect(macdError).toBeVisible();
  await expect(dialog.getByRole("button", { name: /MACD .* 추가/ })).toBeDisabled();
  await screenshot("dialog-validation-error");
  await dialog.getByLabel("느린 기간").fill("26");
  await screenshot("dialog-after-adding");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(rows).toHaveCount(10);
  await expect(row("이동평균 단순 5")).toContainText(/\d/);
  await screenshot("chart-ten-indicators");

  await expect.poll(async () => (await api(LAYOUT)).cells[0].chartSettings.indicators.length).toBe(10);
  const savedKinds = (await api(LAYOUT)).cells[0].chartSettings.indicators.map((i) => i.spec.kind);

  await row("이동평균 단순 20").hover();
  await page.getByRole("button", { name: "이동평균 단순 20 설정" }).click();
  const edit = page.getByRole("dialog", { name: "지표 편집" });
  await expect(edit).toBeVisible();
  await edit.getByLabel("기간", { exact: true }).fill("30");
  await edit.getByRole("button", { name: "변경 적용" }).click();
  await expect(page.getByRole("dialog", { name: "지표 추가" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row("이동평균 단순 30")).toHaveCount(1);
  await expect(row("이동평균 단순 20")).toHaveCount(0);
  await expect.poll(async () => (await api(LAYOUT)).cells[0].chartSettings.indicators.some((i) => i.spec.kind === "ma" && i.spec.period === 30)).toBe(true);
  await screenshot("after-edit-ma30");

  const probe = () => page.evaluate(() => window.seriesProbe());
  const s = await probe();
  const mainLast = s.find((x) => x.type === "Candlestick" && x.count > 0).last;
  expect(typeof mainLast).toBe("number");
  const drawn = s.filter((x) => x.type === "Line" && x.count > 0);
  const future = drawn.filter((x) => x.last > mainLast);
  expect(future).toHaveLength(2);

  await expect.poll(async () => (await fake.registered())["0B"] ?? []).toContain("086520_AL");
  const ma5Before = await row("이동평균 단순 5").innerText();
  const volumeBefore = await row("거래량").innerText();
  const closeBefore = await chart.getAttribute("data-last-close");
  const price = Math.round(Number(closeBefore) * 1.2);
  await expect(async () => {
    await fake.pushReal("0B", "086520_AL", { "20": "100001", "10": `+${price}`, "15": "+3000000", "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2" });
    await expect(chart, "체결이 반영되지 않는다. run.sh에 장 시간 --clock(예: 20261109100000)을 주었는가").toHaveAttribute("data-last-close", String(price), { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect.poll(() => row("이동평균 단순 5").innerText()).not.toBe(ma5Before);
  await expect.poll(() => row("거래량").innerText()).not.toBe(volumeBefore);
  await screenshot("after-trade");

  await row("RSI 14").hover();
  await page.getByRole("button", { name: "RSI 14 숨기기" }).click();
  await expect.poll(async () => (await api(LAYOUT)).cells[0].chartSettings.indicators.find((i) => i.spec.kind === "rsi")?.visible).toBe(false);

  await page.reload();
  await expect(cell).toHaveAttribute("aria-busy", "false");
  await expect(rows).toHaveCount(10);
  await expect(row("이동평균 단순 30")).toHaveCount(1);
  await expect(row("RSI 14")).toHaveClass(/opacity-60/);
  const futureAfterReload = async () => {
    const now = await probe();
    const last = now.find((x) => x.type === "Candlestick" && x.count > 0)?.last;
    return typeof last === "number" ? now.filter((x) => x.type === "Line" && x.count > 0 && x.last > last).length : -1;
  };
  await expect.poll(futureAfterReload).toBe(2);
  await screenshot("after-reload");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await screenshot("phone-390");

  return {
    savedKinds,
    mainLast,
    lineEnds: drawn.map((d) => d.last - mainLast),
    futureSeries: future.map((f) => ({ last: f.last, afterMainBySeconds: f.last - mainLast })),
    ma5Before,
    ma5After: await row("이동평균 단순 5").innerText(),
    volumeBefore,
    volumeAfter: await row("거래량").innerText(),
  };
}
