import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test, type Scenario } from "./harness";
import { chartPoint, drawings, mirror, open, pickTool, settledMirror } from "./drawing-probe";

async function dragBetween(page: Page, from: [number, number], to: [number, number]) {
  const a = await chartPoint(page, ...from);
  const b = await chartPoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}

async function clickAt(page: Page, at: [number, number]) {
  const p = await chartPoint(page, ...at);
  await page.mouse.click(p.x, p.y);
}

async function savedOf(scenario: Scenario, tool: string) {
  const found = (await drawings(scenario)).filter((d) => d.tool === tool);
  expect(found).toHaveLength(1);
  return found[0]!;
}

test("측정 그룹 네 도구를 골라 놓고, 포지션 목표가 핸들을 끌고, 새로고침 뒤에도 보인다", async ({ page, scenario }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const bar = page.getByRole("navigation", { name: "드로잉 도구" });
  await expect(bar.getByRole("button", { name: "측정 도구 펼치기", exact: true })).toBeVisible();

  await pickTool(page, "측정", "가격 범위");
  await dragBetween(page, [0.55, 0.3], [0.62, 0.45]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(1);

  await pickTool(page, "측정", "날짜 범위");
  await dragBetween(page, [0.66, 0.6], [0.74, 0.7]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(2);

  await pickTool(page, "측정", "매도 포지션");
  await clickAt(page, [0.3, 0.5]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(3);

  await pickTool(page, "측정", "매수 포지션");
  await clickAt(page, [0.45, 0.5]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(4);

  expect((await savedOf(scenario, "pricerange")).points).toHaveLength(2);
  expect((await savedOf(scenario, "daterange")).points).toHaveLength(2);
  const [shortEntry, shortTarget, shortStop] = (await savedOf(scenario, "short")).points;
  expect(shortTarget!.price).toBeLessThan(shortEntry!.price);
  expect(shortStop!.price).toBeGreaterThan(shortEntry!.price);
  const placed = await savedOf(scenario, "long");
  expect(placed.points).toHaveLength(3);
  const [entry, target, stop] = placed.points;
  expect(target!.price).toBeGreaterThan(entry!.price);
  expect(stop!.price).toBeLessThan(entry!.price);
  expect(target!.t).toBeGreaterThan(entry!.t);

  const longMirror = (await mirror(page)).find((m) => m.id === placed.id)!;
  expect(longMirror.selected).toBe(true);
  const handle = longMirror.handles[0]!;
  const r = (await chartOf(cell(page)).boundingBox())!;
  await page.mouse.move(r.x + handle.x, r.y + handle.y);
  await page.mouse.down();
  await page.mouse.move(r.x + handle.x, r.y + handle.y - 40, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await savedOf(scenario, "long")).points[1]!.price).toBeGreaterThan(target!.price);
  const dragged = await savedOf(scenario, "long");
  expect(dragged.points[0]).toEqual(entry);
  expect(dragged.points[2]).toEqual(stop);

  await cell(page).focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await mirror(page)).some((m) => m.selected)).toBe(false);
  const before = await drawings(scenario);
  const screens = new Map((await settledMirror(page)).map((m) => [m.id, m.points]));
  await page.reload();
  await expect.poll(async () => (await mirror(page)).length).toBe(4);
  expect(await drawings(scenario)).toEqual(before);
  const drift = async () => (await mirror(page)).flatMap((m) => m.points.map((p, i) => {
    const was = screens.get(m.id)![i]!;
    return p === null ? Infinity : Math.max(Math.abs(p.x - was.x), Math.abs(p.y - was.y));
  }));
  await expect.poll(async () => Math.max(...(await drift()))).toBeLessThan(1);
  expect(errors).toEqual([]);
});

test("포지션 세부 설정: 목표가와 손절가를 진입가 반대쪽에 넣으면 핸들처럼 진입가에서 멈춘다", async ({ page, scenario }) => {
  await open(page);
  await pickTool(page, "측정", "매수 포지션");
  await clickAt(page, [0.45, 0.5]);
  await expect.poll(async () => (await drawings(scenario)).length).toBe(1);
  const [entry, target, stop] = (await savedOf(scenario, "long")).points;
  await page.getByRole("button", { name: "드로잉 세부 설정" }).click();
  const dialog = page.getByRole("dialog", { name: "매수 포지션 세부 설정" });
  await dialog.locator("summary").filter({ hasText: /^좌표$/ }).click();
  await dialog.getByLabel("목표 가격").fill(String(entry!.price - 100));
  await dialog.getByLabel("손절 가격").fill(String(entry!.price + 100));
  await dialog.getByRole("button", { name: "확인", exact: true }).click();
  await expect.poll(async () => (await savedOf(scenario, "long")).points).toEqual([entry, { ...target, price: entry!.price }, { ...stop, price: entry!.price }]);
  await page.getByRole("button", { name: "드로잉 세부 설정" }).click();
  await dialog.locator("summary").filter({ hasText: /^좌표$/ }).click();
  await dialog.getByLabel("목표 시각", { exact: true }).fill(await dialog.getByLabel("진입 시각", { exact: true }).inputValue());
  await dialog.getByRole("button", { name: "확인", exact: true }).click();
  await expect.poll(async () => (await savedOf(scenario, "long")).points[1]!.t).not.toBe(target!.t);
  expect((await savedOf(scenario, "long")).points[1]!.t).toBeGreaterThan(entry!.t);
});

async function dragHandle(page: Page, handle: { x: number; y: number }, by: { x: number; y: number }) {
  const r = (await chartOf(cell(page)).boundingBox())!;
  await page.mouse.move(r.x + handle.x, r.y + handle.y);
  await page.mouse.down();
  await page.mouse.move(r.x + handle.x + by.x, r.y + handle.y + by.y, { steps: 10 });
  await page.mouse.up();
}

async function choosePeriod(page: Page, label: string) {
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: label, exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", new RegExp(` ${label}$`));
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("날짜·가격 범위, 기준봉 VWAP, 구간 거래량 프로파일을 놓고 핸들을 끌면 시각만 바뀌고, 주봉과 새로고침 뒤에도 보인다", async ({ page, scenario }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const traded = (symbol: string) => scenario.market.page({ symbol }).bars.some((b) => b.v > 0);
  const symbol = traded("IDX:001") ? "IDX:001" : "005930";
  expect(traded(symbol), `${symbol} 봉의 거래량`).toBe(true);
  await page.goto(symbol === "IDX:001" ? "/" : `/?symbol=${symbol}`);
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  const saved = () => scenario.documents.drawings(symbol);
  const one = async (tool: string) => {
    const found = (await saved()).filter((d) => d.tool === tool);
    expect(found, tool).toHaveLength(1);
    return found[0]!;
  };

  await pickTool(page, "측정", "날짜·가격 범위");
  await dragBetween(page, [0.2, 0.3], [0.32, 0.45]);
  await expect.poll(async () => (await saved()).length).toBe(1);
  expect((await one("datepricerange")).points).toHaveLength(2);

  await pickTool(page, "측정", "기준봉 VWAP");
  await clickAt(page, [0.4, 0.5]);
  await expect.poll(async () => (await saved()).length).toBe(2);
  const anchored = await one("avwap");
  expect(anchored.points).toHaveLength(1);
  const vwapMirror = (await mirror(page)).find((m) => m.id === anchored.id)!;
  expect(vwapMirror.selected).toBe(true);
  expect(vwapMirror.handles).toHaveLength(1);
  await dragHandle(page, vwapMirror.handles[0]!, { x: 60, y: -50 });
  await expect.poll(async () => (await one("avwap")).points[0]!.t).toBeGreaterThan(anchored.points[0]!.t);
  expect((await one("avwap")).points[0]!.price).toBe(anchored.points[0]!.price);
  await page.getByRole("button", { name: "드로잉 세부 설정" }).click();
  const vwapSettings = page.getByRole("dialog", { name: "기준봉 VWAP 세부 설정" });
  await vwapSettings.getByLabel("가격 라벨", { exact: true }).uncheck();
  await vwapSettings.getByRole("button", { name: "확인", exact: true }).click();
  await expect.poll(async () => (await one("avwap")).style).toMatchObject({ priceLabel: false });

  await pickTool(page, "측정", "구간 거래량 프로파일");
  await dragBetween(page, [0.55, 0.5], [0.85, 0.5]);
  await expect.poll(async () => (await saved()).length).toBe(3);
  const profile = await one("volprofile");
  expect(profile.points).toHaveLength(2);
  expect(profile.points[1]!.t).toBeGreaterThan(profile.points[0]!.t);
  const profileMirror = (await mirror(page)).find((m) => m.id === profile.id)!;
  expect(profileMirror.selected).toBe(true);
  expect(profileMirror.handles).toHaveLength(2);
  await dragHandle(page, profileMirror.handles[1]!, { x: -50, y: 40 });
  await expect.poll(async () => (await one("volprofile")).points[1]!.t).toBeLessThan(profile.points[1]!.t);
  const dragged = await one("volprofile");
  expect(dragged.points[0]).toEqual(profile.points[0]);
  expect(dragged.points[1]!.price).toBe(profile.points[1]!.price);

  await page.getByRole("button", { name: "드로잉 세부 설정" }).click();
  const settings = page.getByRole("dialog", { name: "구간 거래량 프로파일 세부 설정" });
  for (const [label, typed] of [["줄 수", "12"], ["폭 비율", "25"], ["값 영역 비율", "35"]] as const) {
    await settings.getByLabel(label, { exact: true }).selectText();
    await settings.getByLabel(label, { exact: true }).pressSequentially(typed);
  }
  await settings.getByLabel("POC 가격 라벨", { exact: true }).uncheck();
  await settings.getByRole("button", { name: "확인", exact: true }).click();
  await expect.poll(async () => (await one("volprofile")).style).toMatchObject({ rows: 12, widthPercent: 25, valuePercent: 35, pocLabel: false });

  await cell(page).focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await mirror(page)).some((m) => m.selected)).toBe(false);
  const placed = async () => (await mirror(page)).map((m) => [m.tool, m.points.every((p) => p !== null)]);
  const all = [["avwap", true], ["datepricerange", true], ["volprofile", true]];
  await choosePeriod(page, "주");
  await expect.poll(async () => (await placed()).sort()).toEqual(all);
  await page.getByRole("button", { name: "개체 목록 열기", exact: true }).click();
  const list = page.getByRole("region", { name: "개체 목록" });
  const pane = await chartOf(cell(page)).evaluate((el) => {
    const r = [...el.querySelectorAll("canvas")].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const shot = () => page.screenshot({ clip: pane, mask: [page.getByRole("navigation", { name: "드로잉 도구" }), cell(page).locator(".chart-legend")] });
  const painted = await shot();
  for (const label of ["날짜·가격 범위", "기준봉 VWAP", "구간 거래량 프로파일"]) {
    await list.getByRole("button", { name: `${label} 숨기기`, exact: true }).click();
    await expect.poll(async () => (await shot()).equals(painted), { message: `주봉에서 숨기면 그림이 바뀐다: ${label}` }).toBe(false);
    await list.getByRole("button", { name: `${label} 보이기`, exact: true }).click();
    await expect.poll(async () => (await shot()).equals(painted), { message: `주봉에서 다시 보이면 그림이 돌아온다: ${label}` }).toBe(true);
  }
  await choosePeriod(page, "일");
  await expect.poll(async () => (await placed()).sort()).toEqual(all);

  const before = await saved();
  const screens = new Map((await settledMirror(page)).map((m) => [m.id, m.points]));
  await page.reload();
  await expect.poll(async () => (await mirror(page)).length).toBe(3);
  expect(await saved()).toEqual(before);
  const drift = async () => (await mirror(page)).flatMap((m) => m.points.map((p, i) => {
    const was = screens.get(m.id)![i]!;
    return p === null ? Infinity : Math.max(Math.abs(p.x - was.x), Math.abs(p.y - was.y));
  }));
  await expect.poll(async () => Math.max(...(await drift()))).toBeLessThan(1);
  expect(errors).toEqual([]);
});
