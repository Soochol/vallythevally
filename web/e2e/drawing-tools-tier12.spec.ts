import type { Page } from "@playwright/test";
import { expect, pollSaved, test } from "./harness";
import { chartPoint, drawings, mirror, open, pickTool } from "./drawing-probe";

async function click(page: Page, at: [number, number]) {
  const p = await chartPoint(page, ...at);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.click(p.x, p.y);
}

test("Tier 1+2 영구 도구 8종을 배치·편집하고 새로고침 후에도 유지된다", async ({ page, scenario }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);

  await pickTool(page, "도형", "형광펜");
  const h1 = await chartPoint(page, 0.15, 0.3);
  const h2 = await chartPoint(page, 0.3, 0.28);
  await page.mouse.move(h1.x, h1.y);
  await page.mouse.down();
  await page.mouse.move(h2.x, h2.y, { steps: 10 });
  await page.mouse.up();
  await pollSaved(async () => (await drawings(scenario)).map((d) => d.tool)).toContain("highlighter");

  await pickTool(page, "주석", "고정 글자");
  await click(page, [0.2, 0.2]);
  const editor = page.getByRole("textbox", { name: "드로잉 글자" });
  await expect(editor).toBeFocused();
  await editor.fill("손절 -3% 원칙");
  await editor.press("Enter");
  await expect(editor).toBeHidden();
  await pollSaved(async () => (await drawings(scenario)).find((d) => d.tool === "anchoredtext")?.text).toBe("손절 -3% 원칙");

  await pickTool(page, "도형", "곡선");
  await click(page, [0.35, 0.65]);
  await click(page, [0.55, 0.65]);
  await click(page, [0.45, 0.4]);
  await pollSaved(async () => (await drawings(scenario)).map((d) => d.tool)).toContain("curve");

  await pickTool(page, "선", "분리 채널");
  await click(page, [0.2, 0.7]);
  await click(page, [0.45, 0.55]);
  await click(page, [0.32, 0.45]);
  await pollSaved(async () => (await drawings(scenario)).map((d) => d.tool)).toContain("disjointchannel");

  await pickTool(page, "주석", "가격 노트");
  await click(page, [0.58, 0.52]);
  await click(page, [0.68, 0.42]);
  await expect(editor).toBeFocused();
  await editor.fill("전고점 돌파");
  await editor.press("Enter");
  await expect(editor).toBeHidden();
  await pollSaved(async () => (await drawings(scenario)).find((d) => d.tool === "pricenote")?.text).toBe("전고점 돌파");

  await pickTool(page, "주석", "매수 화살표");
  await click(page, [0.62, 0.72]);
  await pickTool(page, "주석", "매도 화살표");
  await click(page, [0.72, 0.35]);

  await pickTool(page, "패턴", "봉 패턴");
  await click(page, [0.22, 0.5]);
  await click(page, [0.38, 0.45]);
  await click(page, [0.76, 0.55]);

  const expected = ["anchoredtext", "arrowdown", "arrowup", "barspattern", "curve", "disjointchannel", "highlighter", "pricenote"];
  await pollSaved(async () => (await drawings(scenario)).map((d) => d.tool).sort()).toEqual(expected);
  await expect.poll(async () => (await mirror(page)).map((d) => d.tool).sort()).toEqual(expected);

  await page.reload();
  await expect.poll(async () => (await mirror(page)).map((d) => d.tool).sort()).toEqual(expected);
  expect(errors).toEqual([]);
});
