import { mkdir } from "node:fs/promises";
import path from "node:path";
import { cell, expect, test } from "./harness";

test("공통 메뉴는 잘리지 않고 선택·키보드·포커스와 분봉 고정 복원을 지원한다", async ({ app, page }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const style = page.getByRole("button", { name: "봉 모양", exact: true });
  const menu = page.getByRole("menu", { name: "봉 모양", exact: true });
  for (const name of ["캔들", "바", "라인", "영역"]) {
    await style.click();
    await expect(menu.locator(":scope")).toBeVisible();
    await expect(menu.getByRole("menuitemradio")).toHaveCount(4);
    for (const item of await menu.getByRole("menuitemradio").all()) {
      const bounds = await item.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
    }
    await menu.getByRole("menuitemradio", { name, exact: true }).click();
    await expect(style).toBeFocused();
    await expect(style).toHaveAttribute("title", `봉 모양: ${name}`);
  }
  await style.click(); await page.keyboard.press("Home"); await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitemradio", { name: "영역" })).toBeFocused();
  await page.keyboard.press("Home"); await menu.dispatchEvent("keydown", { key: "라", bubbles: true });
  await expect(menu.getByRole("menuitemradio", { name: "라인" })).toBeFocused();
  await page.keyboard.press("Enter"); await expect(menu).toBeHidden();
  await style.click(); await page.keyboard.press("Escape"); await expect(style).toBeFocused();
  const minutes = page.getByRole("button", { name: "분봉", exact: true });
  await minutes.click();
  await page.getByRole("menuitemcheckbox", { name: "5분 고정", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "10분", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", /10분/);
  await minutes.click(); await page.keyboard.press("Shift+Digit3");
  await expect(cell(page)).toHaveAttribute("aria-label", /30분/);
  await minutes.click(); await page.keyboard.press("Digit5");
  await expect(cell(page)).toHaveAttribute("aria-label", /5분/);
  await expect(page.getByRole("button", { name: "5분 고정 주기", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await fetch(`${app.url}/api/ui-state`)).json()).pinnedMinutes).toEqual(["5m"]);
  await page.reload();
  await page.getByRole("button", { name: "5분 고정 주기", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", /5분/);
  const magnet = page.getByRole("button", { name: "자석", exact: true });
  await magnet.click({ button: "right" });
  await page.getByRole("menuitemradio", { name: "강", exact: true }).click();
  await expect(magnet).toBeFocused();
  await expect.poll(async () => (await (await fetch(`${app.url}/api/ui-state`)).json()).drawing.magnetStrength).toBe("strong");
  await page.reload(); await magnet.click({ button: "right" });
  await expect(page.getByRole("menuitemradio", { name: "강", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape"); await expect(magnet).toBeFocused();
  await magnet.hover(); await page.mouse.down();
  await expect(page.getByRole("menu", { name: "자석 세기", exact: true })).toBeVisible();
  await page.mouse.up(); await page.keyboard.press("Escape");
  await expect(page.locator("select")).toHaveCount(0);
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표 추가", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "지표", exact: true })).toBeFocused();
});

test("공통 범례 SVG와 화면 크기별 메뉴·페이지 경계를 확인한다", async ({ page }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표 추가", exact: true });
  await dialog.getByRole("button", { name: "이동평균 단순 20 추가", exact: true }).click();
  await page.keyboard.press("Escape");
  const row = page.locator("[data-indicator-row]").filter({ hasText: "이동평균" }).first();
  await expect(row).toBeVisible();
  for (const name of ["설정", "숨기기", "지우기"]) {
    const button = row.getByRole("button", { name: new RegExp(`${name}$`) });
    await expect(button.locator("svg")).toHaveCount(1);
    await expect(button).toHaveAttribute("title", name);
  }
  const directory = path.resolve("../target/ux-screens");
  await mkdir(directory, { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    if (size.width > 768) await page.getByRole("button", { name: "봉 모양", exact: true }).click();
    await expect.poll(() => page.evaluate(() => ({ width: document.documentElement.scrollWidth - innerWidth, height: document.documentElement.scrollHeight - innerHeight }))).toEqual({ width: 0, height: 0 });
    const panels = page.locator("[popover]:popover-open");
    for (const panel of await panels.all()) {
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width); expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
    }
    await page.screenshot({ path: path.join(directory, `shared-${size.width}x${size.height}.png`) });
    await page.keyboard.press("Escape");
  }
});

test("되돌릴 수 있는 드로잉 삭제는 공통 알림에서 복원한다", async ({ page, app }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const bounds = await cell(page).boundingBox();
  expect(bounds).not.toBeNull();
  await cell(page).focus(); await page.keyboard.press("H");
  await page.mouse.click(bounds!.x + bounds!.width * 0.7, bounds!.y + bounds!.height * 0.3);
  const drawings = async () => (await (await fetch(`${app.url}/api/drawings?symbol=005930`)).json()) as { id: string }[];
  await expect.poll(async () => (await drawings()).length).toBe(1);
  const original = (await drawings())[0]!.id;
  await page.getByRole("button", { name: "이 종목 드로잉 모두 지우기", exact: true }).click();
  await expect.poll(async () => (await drawings()).length).toBe(0);
  const toast = page.getByRole("status").filter({ hasText: "드로잉 1개를 지웠습니다" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(async () => (await drawings()).map((d) => d.id)).toEqual([original]);
});
