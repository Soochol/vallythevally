import { cell, expect, pollSaved, test } from "./harness";
import { chartPoint, drawingDock, drawings, expandDock, mirror, open } from "./drawing-probe";

test("빠른 측정 모드는 드로잉을 저장하지 않고 측정 뒤 해제된다", async ({ page, scenario }) => {
  await open(page);
  const rail = await expandDock(page);
  const btn = rail.getByRole("button", { name: "빠른 측정", exact: true });
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  const a = await chartPoint(page, 0.3, 0.6);
  const b = await chartPoint(page, 0.55, 0.35);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  expect(await drawings(scenario)).toHaveLength(0);
  expect(await mirror(page)).toHaveLength(0);
});

test("즐겨찾기 퀵 바, 1클릭 연장·템플릿 프리셋, 개체 트리가 함께 동작한다", async ({ page, scenario }) => {
  await open(page);
  const rail = await expandDock(page);
  await rail.getByRole("button", { name: "선 도구 펼치기", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "추세선 막대에 고정", exact: true }).click();
  await page.keyboard.press("Escape");

  const favBar = page.getByRole("toolbar", { name: "즐겨찾기 빠른 도구", exact: true });
  await expect(favBar).toBeVisible();
  await favBar.getByRole("button", { name: "추세선 빠른 도구", exact: true }).click();

  const a = await chartPoint(page, 0.25, 0.6);
  const b = await chartPoint(page, 0.55, 0.35);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await pollSaved(async () => (await drawings(scenario)).length).toBe(1);

  const bar = page.getByRole("toolbar", { name: "드로잉 스타일", exact: true });
  await bar.getByRole("button", { name: "오른쪽 연장", exact: true }).click();
  await pollSaved(async () => (await drawings(scenario))[0]?.style).toMatchObject({ extend: "right" });

  await bar.getByRole("button", { name: "스타일 템플릿", exact: true }).click();
  const tplDialog = page.getByRole("dialog", { name: "스타일 템플릿", exact: true });
  await tplDialog.getByRole("textbox", { name: "새 템플릿 이름", exact: true }).fill("내 추세 프리셋");
  await tplDialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(tplDialog).toContainText("내 추세 프리셋");
  await page.keyboard.press("Escape");

  await rail.getByRole("button", { name: "개체 트리", exact: true }).click();
  const tree = page.getByRole("complementary", { name: "드로잉 개체 트리", exact: true });
  await expect(tree).toBeVisible();
  await expect(tree.getByRole("listitem")).toHaveCount(1);
  await tree.getByRole("button", { name: "숨기기", exact: true }).click();
  await expect.poll(async () => (await mirror(page)).length).toBe(0);
  await tree.getByRole("button", { name: "보이기", exact: true }).click();
  await expect.poll(async () => (await mirror(page)).length).toBe(1);

  await rail.getByRole("button", { name: "모든 드로잉 잠그기", exact: true }).click();
  await expect(drawingDock(page).getByRole("button", { name: "모든 드로잉 잠그기", exact: true })).toHaveAttribute("aria-pressed", "true");
  await cell(page).focus();
});
