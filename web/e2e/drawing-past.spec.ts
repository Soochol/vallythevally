import type { DrawingInput } from "../src/api/generated/DrawingInput";
import type { DrawingTool } from "../src/api/generated/DrawingTool";
import { cell, chartOf, expect, test } from "./harness";
import { settledMirror } from "./drawing-probe";

const SYMBOL = "IDX:001";

test("불러온 첫 봉보다 과거의 점이 있는 드로잉은 과거 봉을 더 불러오기 전과 뒤에 같은 봉 위에 그린다", async ({ page, scenario }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const recent = scenario.market.page({ symbol: SYMBOL, limit: 40 });
  const first = recent.bars[0]!.t;
  const older = scenario.market.page({ symbol: SYMBOL, before: first, limit: 300 });
  const past = older.bars.at(-3)!;
  const inside = recent.bars[5]!;
  const body = (id: string, tool: DrawingTool, z: number): DrawingInput => ({ id, symbol: SYMBOL, tool, points: [{ t: past.t, price: past.c }, { t: inside.t, price: inside.c }], style: {}, text: null, locked: false, hidden: false, periods: null, z, group: null, scope: { kind: "symbol" }, revision: 0 });
  const trend = body("01900000-0000-7000-8000-0000000000a1", "trendline", 1);
  const channel = body("01900000-0000-7000-8000-0000000000a2", "regression", 2);
  scenario.documents.saveDrawing(trend);
  scenario.documents.saveDrawing(channel);
  scenario.reply((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === SYMBOL && !url.searchParams.has("before"), { body: recent });
  const olderRequest = scenario.hold((url) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === SYMBOL && url.searchParams.has("before"));

  await page.goto("/");
  const chart = chartOf(cell(page));
  await expect(chart).toHaveAttribute("data-first-bar-t", String(first));
  const list = page.getByRole("region", { name: "개체 목록" });
  const select = async (name: string) => {
    if (!(await list.isVisible())) await page.getByRole("button", { name: "개체 목록 열기", exact: true }).click();
    await list.getByRole("button", { name: `고르기: ${name}`, exact: true }).click();
  };
  const screens = async () => {
    await select("회귀 채널");
    const shown = await settledMirror(page);
    return { line: shown.find((m) => m.id === trend.id)!, fit: shown.find((m) => m.id === channel.id)! };
  };

  const before = await screens();
  expect(before.line.points.every((p) => p !== null)).toBe(true);
  const [pastX, insideX] = before.line.points.map((p) => p!.x);
  const spacing = (insideX! - pastX!) / 8;
  expect(spacing).toBeGreaterThan(0);
  expect(before.fit.handles).toHaveLength(2);
  expect(before.fit.handles[0]!.x).toBeCloseTo(insideX! - 5 * spacing, 0);

  await olderRequest.received;
  olderRequest.reply({ body: older });
  await expect(chart).toHaveAttribute("data-first-bar-t", String(older.bars[0]!.t));

  const after = await screens();
  const [pastAfter, insideAfter] = after.line.points.map((p) => p!.x);
  expect(insideAfter! - pastAfter!).toBeCloseTo(insideX! - pastX!, 0);
  expect(after.fit.handles[0]!.x).toBeCloseTo(pastAfter!, 0);
  expect(scenario.documents.drawings(SYMBOL).map((d) => d.points)).toEqual([trend.points, channel.points]);
  expect(errors).toEqual([]);
});
