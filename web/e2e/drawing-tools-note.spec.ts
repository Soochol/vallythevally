import type { Page } from "@playwright/test";
import { cell, expect, test } from "./harness";
import { chartPoint, drawings, mirror, open, pickTool } from "./drawing-probe";

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await chartPoint(page, ...from); const b = await chartPoint(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
}

async function click(page: Page, at: [number, number]) {
  const p = await chartPoint(page, ...at); await page.mouse.click(p.x, p.y);
}

test("주석 도구: 글자·말풍선·가격 라벨·화살표를 놓고 새로고침 뒤에도 같은 자리에 보인다", async ({ page, scenario }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await open(page);

  await cell(page).focus(); await page.keyboard.press("X");
  await click(page, [0.7, 0.3]);
  const editor = page.getByRole("textbox", { name: "드로잉 글자" });
  await expect(editor).toBeFocused();
  await expect.poll(async () => (await drawings(scenario)).map((d) => d.tool)).toEqual(["text"]);
  await editor.fill("한글 메모");
  await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(editor).toBeVisible();
  expect((await drawings(scenario))[0]!.text).toBeNull();
  await editor.press("Enter");
  await expect(editor).toBeHidden();
  await expect.poll(async () => (await drawings(scenario)).find((d) => d.tool === "text")?.text).toBe("한글 메모");

  await pickTool(page, "주석", "말풍선");
  await drag(page, [0.55, 0.65], [0.65, 0.5]);
  await expect(editor).toBeFocused();
  await editor.fill("실적 발표");
  await editor.press("Enter");
  await expect.poll(async () => (await drawings(scenario)).find((d) => d.tool === "callout")).toMatchObject({ text: "실적 발표", points: [expect.anything(), expect.anything()] });

  await pickTool(page, "주석", "가격 라벨");
  await click(page, [0.8, 0.6]);
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "드로잉 더 보기" }).click();
  await expect(page.getByRole("menuitem", { name: "복제", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "글자 고치기…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await pickTool(page, "주석", "화살표");
  await drag(page, [0.82, 0.75], [0.9, 0.65]);
  await expect.poll(async () => (await drawings(scenario)).map((d) => d.tool).sort()).toEqual(["arrow", "callout", "pricelabel", "text"]);
  const saved = await drawings(scenario);
  expect(saved.find((d) => d.tool === "pricelabel")!.points).toHaveLength(1);
  expect(saved.find((d) => d.tool === "arrow")!.points).toHaveLength(2);

  await page.getByRole("button", { name: "개체 목록 열기", exact: true }).click();
  const list = page.getByRole("region", { name: "개체 목록" });
  for (const name of ["한글 메모", "실적 발표", "가격 라벨", "화살표"]) await expect(list.getByRole("button", { name: `고르기: ${name}`, exact: true })).toBeVisible();

  const byId = (ms: Awaited<ReturnType<typeof mirror>>) => Object.fromEntries(ms.map((m) => [m.id, m.points]));
  const before = byId(await mirror(page));
  expect(Object.values(before).flat().every((p) => p !== null)).toBe(true);
  await page.reload();
  await expect.poll(async () => (await mirror(page)).length).toBe(4);
  const after = byId(await mirror(page));
  for (const [id, points] of Object.entries(before)) {
    expect(after[id]).toHaveLength(points.length);
    points.forEach((p, i) => { expect(after[id]![i]!.x).toBeCloseTo(p!.x, 0); expect(after[id]![i]!.y).toBeCloseTo(p!.y, 0); });
  }
  expect((await drawings(scenario)).map((d) => d.points)).toEqual(saved.map((d) => d.points));
  await page.screenshot({ path: testInfo.outputPath("note-tools.png") });
  expect(errors).toEqual([]);
});

test("주석 도구: 공백뿐인 글자는 자리 표시로 남고, 바깥을 누르면 확정하고, 입력 칸에서 세부 설정을 연다", async ({ page, scenario }, testInfo) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await cell(page).focus(); await page.keyboard.press("X");
  await click(page, [0.4, 0.3]);
  const editor = page.getByRole("textbox", { name: "드로잉 글자" });
  await editor.fill("   ");
  await editor.press("Enter");
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "개체 목록 열기", exact: true }).click();
  await expect(page.getByRole("region", { name: "개체 목록" }).getByRole("button", { name: "고르기: 글자", exact: true })).toBeVisible();
  expect((await drawings(scenario))[0]!.text).toBeNull();

  await cell(page).focus(); await page.keyboard.press("X");
  await click(page, [0.3, 0.6]);
  await editor.fill("바깥 누르기");
  await page.getByRole("region", { name: "개체 목록" }).click();
  await expect(editor).toBeHidden();
  await expect.poll(async () => (await drawings(scenario)).map((d) => d.text)).toContain("바깥 누르기");
  await cell(page).focus(); await page.keyboard.press("X");
  await click(page, [0.3, 0.75]);
  await editor.fill("버릴 글자");
  await editor.press("Escape");
  await expect(editor).toBeHidden();
  expect((await drawings(scenario)).map((d) => d.text)).not.toContain("버릴 글자");
  await cell(page).focus(); await page.keyboard.press("X");
  await click(page, [0.2, 0.45]);
  await editor.fill("  ");
  await page.locator(".draw-text-editor").getByRole("button", { name: "세부 설정", exact: true }).click();
  await page.getByRole("dialog", { name: "글자 세부 설정" }).getByRole("button", { name: "확인", exact: true }).click();
  await expect.poll(async () => (await drawings(scenario)).filter((d) => d.tool === "text").map((d) => d.text ?? "").sort()).toEqual(["", "", "", "바깥 누르기"]);

  await pickTool(page, "주석", "말풍선");
  await drag(page, [0.55, 0.65], [0.65, 0.5]);
  await editor.fill("배당");
  await page.screenshot({ path: testInfo.outputPath("text-editor.png") });
  await page.locator(".draw-text-editor").getByRole("button", { name: "세부 설정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "말풍선 세부 설정" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox", { name: "테두리", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "확인", exact: true }).click();
  await expect.poll(async () => (await drawings(scenario)).find((d) => d.tool === "callout")).toMatchObject({ text: "배당", style: { border: false } });
  expect(errors).toEqual([]);
});
