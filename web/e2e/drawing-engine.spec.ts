import { test, expect, cell, chartOf, type App } from "./harness";
import type { Page } from "@playwright/test";
import type { Drawing } from "../src/api/generated/Drawing";
import type { Bar } from "../src/api/generated/Bar";
import type { DrawingBody } from "../src/chart/drawings/types";
import { completionKey } from "../src/chart/drawings/journal";

interface Mirror { id: string; tool: string; selected: boolean; points: ({ x: number; y: number } | null)[]; handles: { x: number; y: number }[] }
async function mirror(page: Page): Promise<Mirror[]> {
  const json = await chartOf(cell(page)).locator(".drawing-mirror").getAttribute("data-drawings");
  return JSON.parse(json ?? "[]");
}
const drawings = async (app: App): Promise<Drawing[]> => (await fetch(`${app.url}/api/drawings?symbol=IDX%3A001`)).json();
async function open(page: Page) {
  await page.goto("/");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
}
async function draw(page: Page, tool = "T", shift = false) {
  const chart = chartOf(cell(page)); const r = (await chart.boundingBox())!;
  await cell(page).focus(); await page.keyboard.press(tool);
  await page.mouse.move(r.x + r.width * 0.76, r.y + r.height * 0.35); await page.mouse.down();
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(r.x + r.width * 0.86, r.y + r.height * 0.25, { steps: 12 }); await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
  return r;
}

test("trendline placement, handles, settings, and persistence", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await draw(page);
  await expect.poll(async () => (await drawings(app)).length).toBe(1);
  await expect(page.getByRole("toolbar", { name: "드로잉 스타일" })).toBeVisible();
  const saved = (await drawings(app))[0]!;
  const xBeforePan = (await mirror(page))[0]!.points[0]!.x;
  const r = (await chartOf(cell(page)).boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.4, r.y + r.height * 0.6); await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.55, r.y + r.height * 0.6, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => (await mirror(page))[0]!.points[0]!.x).toBeGreaterThan(xBeforePan + 50);
  expect((await drawings(app))[0]!.points).toEqual(saved.points);
  await page.reload();
  await expect.poll(async () => (await mirror(page)).length).toBe(1);
  expect((await drawings(app))[0]!.points).toEqual(saved.points);
  expect(errors).toEqual([]);
});

test("drawing engine: remembered style and preferences survive reload; drawing clears hide-all", async ({ page, app }) => {
  await open(page); const r = await draw(page); await expect.poll(async () => (await drawings(app)).length).toBe(1);
  await page.getByRole("toolbar", { name: "드로잉 스타일" }).getByLabel("선 굵기").selectOption("4");
  await page.getByRole("button", { name: "모든 드로잉 숨기기", exact: true }).click();
  await expect.poll(async () => (await mirror(page)).length).toBe(0);
  await cell(page).focus(); await page.keyboard.press("T");
  await page.mouse.move(r.x + r.width * 0.77, r.y + r.height * 0.6); await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.86, r.y + r.height * 0.5, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await drawings(app)).length).toBe(2);
  await expect.poll(async () => (await mirror(page)).length).toBe(2);
  const styles = (await drawings(app)).map((d) => d.style as { line: { width: number } });
  expect(styles.map((s) => s.line.width)).toEqual([4, 4]);
  await page.getByRole("combobox", { name: "자석 세기" }).selectOption("strong");
  await expect.poll(async () => (await (await fetch(`${app.url}/api/ui-state`)).json()).drawing?.magnetStrength).toBe("strong");
  await page.reload(); await expect(page.getByRole("combobox", { name: "자석 세기" })).toHaveValue("strong");
  await expect.poll(async () => (await mirror(page)).length).toBe(2);
});

test("drawing engine: handles, Shift 45°, clone, clipboard, undo and redo", async ({ page, app }) => {
  await open(page); await cell(page).focus(); await page.keyboard.press("G");
  const r = await draw(page, "T", true);
  await expect.poll(async () => (await drawings(app)).length).toBe(1);
  const original = (await drawings(app))[0]!;
  const line = (await mirror(page))[0]!; const [a, b] = line.points;
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  expect(Math.abs(Math.abs(b!.x - a!.x) - Math.abs(b!.y - a!.y))).toBeLessThan(1);
  await page.mouse.move(r.x + b!.x, r.y + b!.y); await page.mouse.down();
  await page.mouse.move(r.x + b!.x + 20, r.y + b!.y - 30, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await drawings(app))[0]!.points[1]).not.toEqual(original.points[1]);
  expect((await drawings(app))[0]!.points[0]).toEqual(original.points[0]);
  const afterHandle = (await drawings(app))[0]!.points;
  const moved = (await mirror(page))[0]!; const p0 = moved.points[0]!; const p1 = moved.points[1]!;
  const x = (p0.x + p1.x) / 2; const y = (p0.y + p1.y) / 2;
  await page.keyboard.down("Control"); await page.mouse.move(r.x + x, r.y + y); await page.mouse.down();
  await page.mouse.move(r.x + x + 18, r.y + y + 24, { steps: 10 }); await page.mouse.up(); await page.keyboard.up("Control");
  await expect.poll(async () => (await drawings(app)).length).toBe(2);
  expect((await drawings(app)).find((d) => d.id === original.id)!.points).toEqual(afterHandle);
  await cell(page).focus(); await page.keyboard.press("Control+c"); await page.keyboard.press("Control+v");
  await expect.poll(async () => (await drawings(app)).length).toBe(3);
  await page.keyboard.press("Control+z"); await expect.poll(async () => (await drawings(app)).length).toBe(2);
  await page.keyboard.press("Control+y"); await expect.poll(async () => (await drawings(app)).length).toBe(3);
  await page.getByRole("button", { name: "개체 목록 열기" }).click();
  await expect(page.getByRole("region", { name: "개체 목록" }).getByRole("button", { name: "고르기: 추세선" })).toHaveCount(3);
});

test("drawing engine: daily anchors keep their time and price on 60-minute bars", async ({ page, app }) => {
  const first = Date.UTC(2026, 4, 1) / 1000 - 9 * 3600;
  await page.route("**/api/bars?**", async (route) => {
    const q = new URL(route.request().url()).searchParams; const period = q.get("period")!;
    const hours = period === "60m"; const n = hours ? 3600 : 150; const length = hours ? 3600 : 86400;
    const bars: Bar[] = Array.from({ length: n }, (_, i) => { const price = 5000 + Math.sin(i / (hours ? 240 : 10)) * 200;
      return { t: first + i * length, o: price, h: price + 50, l: price - 50, c: price + 10, v: 1000 }; });
    await route.fulfill({ json: { symbol: "IDX:001", venue: null, period, bars, current: null, nextBefore: null, seq: null } });
  });
  await open(page); await cell(page).focus(); await page.keyboard.press("G"); await draw(page);
  await expect.poll(async () => (await drawings(app)).length).toBe(1);
  const saved = (await drawings(app))[0]!; const before = (await mirror(page))[0]!.points;
  await page.getByRole("combobox", { name: "분봉" }).selectOption("60m");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 코스피 60분");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "3600");
  await expect.poll(async () => (await mirror(page))[0]?.points.every((p) => p !== null)).toBe(true);
  const after = (await mirror(page))[0]!.points;
  expect((after[1]!.x - after[0]!.x) / (before[1]!.x - before[0]!.x)).toBeCloseTo(24, 1);
  expect((await drawings(app))[0]!.points).toEqual(saved.points);
  await page.reload(); await expect.poll(async () => (await mirror(page)).length).toBe(1);
  expect((await drawings(app))[0]!.points).toEqual(saved.points);
});

test("drawing engine: lock, hide, order, multi-selection and object list", async ({ page, app }) => {
  await open(page); const r = await draw(page);
  await expect.poll(async () => (await drawings(app)).length).toBe(1);
  await cell(page).focus(); await page.keyboard.press("H"); await page.mouse.click(r.x + r.width * 0.85, r.y + r.height * 0.48);
  await expect.poll(async () => (await drawings(app)).length).toBe(2);
  await page.getByRole("button", { name: "잠금", exact: true }).click();
  await expect.poll(async () => (await drawings(app)).find((d) => d.tool === "hline")!.locked).toBe(true);
  await cell(page).focus(); await page.keyboard.press("Delete");
  await expect.poll(async () => (await drawings(app)).length).toBe(2);
  await page.getByRole("button", { name: "개체 목록 열기" }).click();
  const list = page.getByRole("region", { name: "개체 목록" });
  await list.getByRole("button", { name: "수평선 잠금 풀기", exact: true }).click();
  await list.getByRole("button", { name: "수평선 숨기기", exact: true }).click();
  await expect.poll(async () => (await mirror(page)).length).toBe(1);
  await expect(list.getByRole("button", { name: "고르기: 수평선" })).toBeDisabled();
  await list.getByRole("button", { name: "수평선 보이기", exact: true }).click();
  await list.getByRole("button", { name: "고르기: 추세선" }).click();
  await list.getByRole("button", { name: "고르기: 수평선" }).click({ modifiers: ["Control"] });
  await expect.poll(async () => (await mirror(page)).filter((d) => d.selected).length).toBe(2);
  const before = await drawings(app);
  await cell(page).focus(); await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await drawings(app)).every((d) => d.points[0]!.price !== before.find((b) => b.id === d.id)!.points[0]!.price)).toBe(true);
  await page.keyboard.press("Control+z"); await expect.poll(async () => (await drawings(app)).map((d) => d.points)).toEqual(before.map((d) => d.points));
  await list.getByRole("button", { name: "고르기: 추세선" }).click();
  await page.getByRole("button", { name: "드로잉 더 보기" }).click();
  await page.getByRole("menuitem", { name: "맨 앞으로", exact: true }).click();
  await expect.poll(async () => { const ds = await drawings(app); return ds.find((d) => d.tool === "trendline")!.z > ds.find((d) => d.tool === "hline")!.z; }).toBe(true);
});

test("drawing engine: settings preview, cancellation, coordinates and text", async ({ page, app }, testInfo) => {
  await open(page); await draw(page);
  await expect.poll(async () => (await drawings(app)).length).toBe(1);
  const original = (await drawings(app))[0]!;
  await page.getByRole("button", { name: "드로잉 설정" }).click();
  const dialog = page.getByRole("dialog", { name: "추세선 설정" });
  const defaultColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--draw").trim());
  await expect(dialog.getByRole("button", { name: "선 색 선택", exact: true })).toContainText(defaultColor.toUpperCase());
  await dialog.getByLabel("선 굵기").selectOption("4");
  await dialog.getByRole("button", { name: "선 색 선택", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "선 색", exact: true });
  await picker.getByRole("tab", { name: "사용자 지정", exact: true }).click();
  await picker.getByRole("textbox", { name: "HEX", exact: true }).fill("#224466");
  await picker.getByRole("button", { name: "선택", exact: true }).click();
  expect((await drawings(app))[0]!.style).toEqual(original.style);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  expect((await drawings(app))[0]!.style).toEqual(original.style);
  await page.getByRole("button", { name: "드로잉 설정" }).click();
  await dialog.getByRole("tab", { name: "좌표", exact: true }).click();
  await dialog.getByLabel("점 1 가격").fill(String(original.points[0]!.price + 10));
  await dialog.getByRole("tab", { name: "글자", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "글자 색 선택", exact: true })).toContainText(defaultColor.toUpperCase());
  await dialog.getByRole("textbox", { name: "글자", exact: true }).fill("지지 구간");
  await page.screenshot({ path: testInfo.outputPath("settings.png") });
  await dialog.getByRole("button", { name: "확인", exact: true }).click();
  await expect.poll(async () => (await drawings(app))[0]!.text).toBe("지지 구간");
  expect((await drawings(app))[0]!.points[0]!.price).toBe(original.points[0]!.price + 10);
  expect((await drawings(app))[0]!.style).toMatchObject({ line: { color: "$draw" }, label: { color: "$draw" } });
  await page.getByRole("button", { name: "개체 목록 열기" }).click();
  await expect(page.getByRole("button", { name: "고르기: 지지 구간" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop.png") });
  await page.getByRole("button", { name: "드로잉 더 보기" }).click();
  await page.getByRole("menuitem", { name: "글자 고치기…" }).click();
  const inline = page.getByRole("textbox", { name: "드로잉 글자" });
  await inline.fill("한글 조합");
  await inline.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(inline).toBeVisible();
  expect((await drawings(app))[0]!.text).toBe("지지 구간");
  await inline.press("Enter");
  await expect.poll(async () => (await drawings(app))[0]!.text).toBe("한글 조합");
});

test("drawing engine: Alt tool aliases consume browser shortcuts and text fields keep their keys", async ({ page, app }) => {
  await open(page); const r = await draw(page, "Alt+t");
  await expect.poll(async () => (await drawings(app)).length).toBe(1);
  await cell(page).focus(); await page.keyboard.press("Alt+h"); await page.mouse.click(r.x + r.width * 0.84, r.y + r.height * 0.5);
  await expect.poll(async () => (await drawings(app)).length).toBe(2);
  await cell(page).focus();
  const prevented = await cell(page).evaluate((el) => {
    const e = new KeyboardEvent("keydown", { code: "KeyF", altKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(e); return e.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await page.keyboard.press("Alt+f");
  await expect(cell(page)).toBeFocused();
  await page.getByRole("button", { name: "드로잉 설정" }).click();
  const dialog = page.getByRole("dialog", { name: "수평선 설정" });
  await dialog.getByRole("tab", { name: "글자", exact: true }).click();
  const input = dialog.getByRole("textbox", { name: "글자", exact: true });
  await input.fill("A"); await input.press("Control+a"); await input.press("Control+c");
  await expect(dialog).toBeVisible(); await expect.poll(async () => (await drawings(app)).length).toBe(2);
});

test("drawing engine: phone shows persisted shapes without editing controls", async ({ page, app }, testInfo) => {
  await open(page); await draw(page); await expect.poll(async () => (await drawings(app)).length).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation", { name: "드로잉 도구" })).toBeHidden();
  await expect(page.getByRole("toolbar", { name: "드로잉 스타일" })).toBeHidden();
  await expect.poll(async () => (await mirror(page)).length).toBe(1);
  expect((await mirror(page))[0]!.handles).toHaveLength(0);
  const r = (await chartOf(cell(page)).boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.8, r.y + r.height * 0.4); await page.keyboard.press("Delete");
  expect(await drawings(app)).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath("phone.png") });
});

test("drawing engine: another tab's edit prevents undoing its content", async ({ page, context, app }) => {
  await open(page); await draw(page); await expect.poll(async () => (await drawings(app)).length).toBe(1);
  const original = (await drawings(app))[0]!;
  const other = await context.newPage(); await open(other);
  await other.getByRole("button", { name: "개체 목록 열기" }).click();
  await other.getByRole("button", { name: "고르기: 추세선" }).click();
  await other.keyboard.press("ArrowUp");
  await expect.poll(async () => (await drawings(app))[0]!.points).not.toEqual(original.points);
  const changed = (await drawings(app))[0]!;
  await page.bringToFront(); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(async () => (await mirror(page))[0]!.points[0]!.y).not.toBeNull();
  await expect(page.getByRole("button", { name: "드로잉 설정" })).toBeVisible();
  await cell(page).focus(); await page.keyboard.press("Control+z");
  await expect(page.getByText("다른 곳에서 바뀐 드로잉이라 되돌리지 않았습니다")).toBeVisible();
  expect((await drawings(app))[0]!.points).toEqual(changed.points);
  await other.close();
});

test("drawing engine: completed legacy replay is retired locally and the newer server edit wins", async ({ page, app }) => {
  await open(page); await draw(page); await expect.poll(async () => (await drawings(app)).length).toBe(1);
  await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
  const original = (await drawings(app))[0]!;
  const changed = { ...original, points: original.points.map((p) => ({ ...p, price: p.price + 100 })), revision: original.revision + 100 };
  const put = await fetch(`${app.url}/api/drawings/${original.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(changed) });
  expect(put.status).toBe(200);
  const completed = await page.evaluate(key => localStorage.getItem(key), completionKey(original.id));
  expect(completed).not.toBeNull();
  await page.evaluate((d) => localStorage.setItem(`vv.unsaved.drawing.${d.id}`, JSON.stringify({ v: 1, id: d.id, symbol: d.symbol, lastRevision: d.revision, want: { kind: "put", body: d, reserved: true } })), original);
  const requests: string[] = [];
  page.on("request", request => { if (request.url().endsWith(`/api/drawings/${original.id}`) && request.method() === "PUT") requests.push(request.method()); });
  await page.reload();
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`vv.unsaved.drawing.${id}`), original.id)).toBeNull();
  await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
  expect(requests).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), completionKey(original.id))).toBe(completed);
  expect((await drawings(app))[0]!.points).toEqual(changed.points);
});

test("drawing engine: pre-upgrade legacy recovery keeps its fixed revision and receives the server conflict", async ({ page, app }) => {
  const original: DrawingBody = { id: "01900000-0000-7000-8000-000000000054", symbol: "IDX:001", tool: "hline", points: [{ t: 1700000000, price: 6000 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 731 };
  const changed = { ...original, points: original.points.map(point => ({ ...point, price: point.price + 100 })), revision: 831 };
  for (const body of [original, changed]) {
    const response = await fetch(`${app.url}/api/drawings/${body.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
  }
  await page.route("**/__legacy-fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Legacy origin fixture</title>" }));
  await page.goto("/__legacy-fixture");
  expect(await page.evaluate(key => localStorage.getItem(key), completionKey(original.id))).toBeNull();
  await page.evaluate(d => localStorage.setItem(`vv.unsaved.drawing.${d.id}`, JSON.stringify({ v: 1, id: d.id, symbol: d.symbol, lastRevision: d.revision, want: { kind: "put", body: d, reserved: true } })), original);
  const stale = page.waitForResponse(response => response.url().endsWith(`/api/drawings/${original.id}`) && response.status() === 409);
  await open(page);
  const rejected = await stale;
  expect(rejected.request().postDataJSON()).toEqual(original);
  await expect.poll(() => page.evaluate(id => localStorage.getItem(`vv.unsaved.drawing.${id}`), original.id)).toBeNull();
  expect((await drawings(app))[0]!.points).toEqual(changed.points);
  await expect(page.getByText("다른 곳의 새 수정이 있어 드로잉을 다시 불러왔습니다")).toBeVisible();
});

test("drawing engine: reload recovers an unsent edit and box selection selects both tools", async ({ page, app }) => {
  await page.route("**/api/drawings/*", (route) => route.request().method() === "PUT" ? route.abort() : route.continue());
  await open(page); const r = await draw(page);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("vv.unsaved.drawing.")).length)).toBe(1);
  expect(await drawings(app)).toHaveLength(0);
  await page.unroute("**/api/drawings/*"); await page.reload();
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await expect.poll(async () => (await drawings(app)).length).toBe(1);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("vv.unsaved.drawing.")).length)).toBe(0);
  await cell(page).focus(); await page.keyboard.press("H"); await page.mouse.click(r.x + r.width * 0.85, r.y + r.height * 0.48);
  await expect.poll(async () => (await drawings(app)).length).toBe(2);
  await cell(page).focus(); await page.keyboard.down("Control");
  await page.mouse.move(r.x + r.width * 0.7, r.y + r.height * 0.16); await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.9, r.y + r.height * 0.55, { steps: 10 }); await page.mouse.up(); await page.keyboard.up("Control");
  await expect.poll(async () => (await mirror(page)).filter((d) => d.selected).length).toBe(2);
});
