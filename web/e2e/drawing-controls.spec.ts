import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Drawing } from "../src/api/generated/Drawing";
import { cell, chartOf, expect, test, type App } from "./harness";
import { selectOption } from "./select-option";

const drawings = async (app: App): Promise<Drawing[]> => (await (await fetch(`${app.url}/api/drawings?symbol=IDX%3A001`)).json());

test("추세선 작은 막대의 색·굵기·잠금·복제·삭제 되돌리기와 개체 탭을 사용한다", async ({ page, app }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  const chart = await chartOf(cell(page)).boundingBox();
  if (!chart) throw new Error("차트가 없습니다");
  await cell(page).focus();
  await page.keyboard.press("T");
  await page.mouse.move(chart.x + chart.width * 0.76, chart.y + chart.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(chart.x + chart.width * 0.86, chart.y + chart.height * 0.25, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await drawings(app)).length).toBe(1);
  const original = (await drawings(app))[0]!;
  const bar = page.getByRole("toolbar", { name: "드로잉 스타일" });
  await bar.getByRole("button", { name: "선 색 선택", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "선 색", exact: true });
  await expect(picker.getByRole("button", { name: /^기본 색상 \d+ / })).toHaveCount(48);
  await picker.getByRole("tab", { name: "사용자 지정", exact: true }).click();
  await picker.getByRole("textbox", { name: "HEX", exact: true }).fill("#224466");
  await picker.getByRole("button", { name: "선택", exact: true }).click();
  await selectOption(bar.getByLabel("선 굵기", { exact: true }), "4");
  await selectOption(bar.getByLabel("선 모양", { exact: true }), "dashed");
  await expect.poll(async () => (await drawings(app))[0]?.style).toMatchObject({ line: { color: "#224466", width: 4, dash: "dashed" } });
  await bar.getByRole("button", { name: "잠금", exact: true }).click();
  await expect.poll(async () => (await drawings(app))[0]?.locked).toBe(true);
  await bar.getByRole("button", { name: "잠금 풀기", exact: true }).click();
  await bar.getByRole("button", { name: "드로잉 복제", exact: true }).click();
  await expect.poll(async () => (await drawings(app)).length).toBe(2);
  const cloned = (await drawings(app)).find((d) => d.id !== original.id)!;
  expect(cloned.style).toEqual((await drawings(app)).find((d) => d.id === original.id)!.style);
  await bar.getByRole("button", { name: "드로잉 지우기", exact: true }).click();
  await expect.poll(async () => (await drawings(app)).map((d) => d.id)).toEqual([original.id]);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(async () => (await drawings(app)).map((d) => d.id).sort()).toEqual([original.id, cloned.id].sort());
  await page.getByRole("tab", { name: "개체", exact: true }).click();
  const object = page.getByRole("region", { name: "개체 목록" }).locator(`[data-drawing-id="${original.id}"]`);
  await object.getByRole("button", { name: "추세선 숨기기", exact: true }).click();
  await expect.poll(async () => (await drawings(app)).find((d) => d.id === original.id)?.hidden).toBe(true);
  await object.getByRole("button", { name: "추세선 보이기", exact: true }).click();
  await object.getByRole("button", { name: "추세선 잠그기", exact: true }).click();
  await expect.poll(async () => (await drawings(app)).find((d) => d.id === original.id)?.locked).toBe(true);
  await object.getByRole("button", { name: "추세선 잠금 풀기", exact: true }).click();
  await mkdir(resolve("../target/ux-screens"), { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: resolve(`../target/ux-screens/drawings-${size.width}x${size.height}.png`) });
  }
  await object.getByRole("button", { name: "추세선 지우기", exact: true }).click();
  await expect.poll(async () => (await drawings(app)).map((d) => d.id)).toEqual([cloned.id]);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(async () => (await drawings(app)).map((d) => d.id).sort()).toEqual([original.id, cloned.id].sort());
});

test("드로잉 그룹의 별표 고정은 새로고침 뒤 도구와 메뉴에 복원된다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "선 도구 펼치기", exact: true }).click();
  const pinned = page.getByRole("menuitemcheckbox", { name: "수평선 막대에 고정", exact: true });
  await pinned.click();
  await expect(pinned).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "수평선 고정 도구", exact: true })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("자동 저장됨");
  await expect.poll(async () => (await (await page.request.get("/api/ui-state")).json()).drawing.pinnedTools).toContain("hline");
  await page.reload();
  await page.getByRole("button", { name: "수평선 고정 도구", exact: true }).click();
  await expect(page.getByRole("button", { name: "수평선 고정 도구", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "선 도구 펼치기", exact: true }).click();
  await expect(pinned).toHaveAttribute("aria-checked", "true");
});
