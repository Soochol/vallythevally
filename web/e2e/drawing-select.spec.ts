import type { Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";
import { chartPoint, drawings, open, pickTool, settledMirror } from "./drawing-probe";

async function onChart(page: Page, x: number, y: number) {
  const box = (await chartOf(cell(page)).boundingBox())!;
  return { x: box.x + x, y: box.y + y };
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await chartPoint(page, ...from); const b = await chartPoint(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
}

async function writeNote(page: Page, at: { x: number; y: number }, text: string) {
  await cell(page).focus(); await page.keyboard.press("X");
  await page.mouse.click(at.x, at.y);
  const editor = page.getByRole("textbox", { name: "드로잉 글자" });
  await expect(editor).toBeFocused();
  await editor.fill(text); await editor.press("Enter");
  await expect(editor).toBeHidden();
}

async function deselect(page: Page) {
  await cell(page).focus(); await page.keyboard.press("Escape");
  await expect.poll(async () => (await settledMirror(page)).some((m) => m.selected)).toBe(false);
}

const selectedIds = async (page: Page) => (await settledMirror(page)).filter((m) => m.selected).map((m) => m.id);

test("선 위에 놓인 글자 상자를 누르면 가장 위에 그린 글자를 고른다", async ({ page, scenario }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await cell(page).focus(); await page.keyboard.press("G");
  await pickTool(page, "선", "추세선");
  await drag(page, [0.2, 0.5], [0.8, 0.5]);
  await expect.poll(async () => (await drawings(scenario)).map((d) => d.tool)).toEqual(["trendline"]);
  const line = (await settledMirror(page))[0]!;
  const lineY = line.points[0]!.y;
  const x = (line.points[0]!.x + line.points[1]!.x) / 2;
  await writeNote(page, await onChart(page, x, lineY - 6), "선 위 메모");
  await expect.poll(async () => (await drawings(scenario)).map((d) => d.tool).sort()).toEqual(["text", "trendline"]);
  const note = (await drawings(scenario)).find((d) => d.tool === "text")!;
  await deselect(page);

  const spot = await onChart(page, x + 16, lineY);
  await page.mouse.click(spot.x, spot.y);
  await expect.poll(() => selectedIds(page)).toEqual([note.id]);
  expect(errors).toEqual([]);
});

test("글자와 말풍선은 한 번 누르면 고르고, 두 번 누르면 글자 입력 칸을 연다", async ({ page, scenario }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await cell(page).focus(); await page.keyboard.press("G");
  const editor = page.getByRole("textbox", { name: "드로잉 글자" });
  const anchor = await chartPoint(page, 0.3, 0.3);
  await writeNote(page, anchor, "고를 메모");
  await pickTool(page, "주석", "말풍선");
  await drag(page, [0.55, 0.65], [0.7, 0.5]);
  await expect(editor).toBeFocused();
  await editor.fill("고를 말풍선"); await editor.press("Enter");
  await expect(editor).toBeHidden();
  await expect.poll(async () => (await drawings(scenario)).map((d) => d.tool).sort()).toEqual(["callout", "text"]);
  const saved = await drawings(scenario);
  const note = saved.find((d) => d.tool === "text")!;
  const callout = saved.find((d) => d.tool === "callout")!;
  const calloutScreen = (await settledMirror(page)).find((m) => m.id === callout.id)!.points;
  const calloutLine = await onChart(page, (calloutScreen[0]!.x + calloutScreen[1]!.x) / 2, (calloutScreen[0]!.y + calloutScreen[1]!.y) / 2);
  const noteBody = { x: anchor.x + 16, y: anchor.y + 8 };

  for (const [id, spot, title] of [[note.id, noteBody, "글자 세부 설정"], [callout.id, calloutLine, "말풍선 세부 설정"]] as const) {
    await deselect(page);
    await page.mouse.click(spot.x, spot.y);
    await expect.poll(() => selectedIds(page)).toEqual([id]);
    await expect(editor).toBeHidden();
    expect((await settledMirror(page)).find((m) => m.id === id)!.handles.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "드로잉 세부 설정", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title });
    await expect(dialog).toBeVisible();
    await expect(editor).toBeHidden();
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await expect(dialog).toBeHidden();

    await deselect(page);
    await page.mouse.dblclick(spot.x, spot.y);
    await expect(editor).toBeFocused();
    await editor.press("Escape");
    await expect(editor).toBeHidden();
  }
  expect((await drawings(scenario)).map((d) => d.text).sort()).toEqual(["고를 말풍선", "고를 메모"]);
  expect(errors).toEqual([]);
});

test("차트 칸 밖의 시간 축을 두 번 눌러도 드로잉을 고르거나 열지 않는다", async ({ page, scenario }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await cell(page).focus(); await page.keyboard.press("Shift+V");
  const middle = await chartPoint(page, 0.5, 0.5);
  await page.mouse.click(middle.x, middle.y);
  await expect.poll(async () => (await drawings(scenario)).map((d) => d.tool)).toEqual(["vline"]);
  await deselect(page);
  const line = (await settledMirror(page))[0]!;
  const box = (await chartOf(cell(page)).boundingBox())!;
  const axis = { x: box.x + line.points[0]!.x, y: box.y + box.height - 8 };
  await page.mouse.click(axis.x, axis.y);
  await expect.poll(() => selectedIds(page)).toEqual([]);
  await page.mouse.dblclick(axis.x, axis.y);
  await expect(page.getByRole("dialog", { name: "수직선 세부 설정" })).toHaveCount(0);
  await expect.poll(() => selectedIds(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("추세선을 놓는 도중 시간 축을 두 번 눌러도 놓던 점을 버리지 않는다", async ({ page, scenario }) => {
  await open(page);
  await pickTool(page, "선", "추세선");
  const a = await chartPoint(page, 0.3, 0.4);
  await page.mouse.click(a.x, a.y);
  const box = (await chartOf(cell(page)).boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height - 8);
  const b = await chartPoint(page, 0.6, 0.5);
  await page.mouse.click(b.x, b.y);
  await expect.poll(async () => (await drawings(scenario)).map((d) => d.tool)).toEqual(["trendline"]);
});
