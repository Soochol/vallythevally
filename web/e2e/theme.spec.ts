import type { Page } from "@playwright/test";
import { cell, expect, test } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const root = (page: Page) => page.locator("html");

test("테마와 밀도를 바꾸면 즉시 적용되고 새로고침·다른 페이지 이동 뒤에도 유지된다", async ({ page }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(root(page)).toHaveAttribute("data-style", "editorial");
  await expect(root(page)).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await dialog(page).getByRole("tab", { name: /^일반/ }).click();
  await dialog(page).getByRole("radiogroup", { name: "스타일", exact: true }).getByRole("radio", { name: "소프트 벤토", exact: true }).click();
  await dialog(page).getByRole("radiogroup", { name: "색상 모드", exact: true }).getByRole("radio", { name: "화이트", exact: true }).click();
  await dialog(page).getByRole("radiogroup", { name: "목록 밀도", exact: true }).getByRole("radio", { name: "기본", exact: true }).click();

  await expect(root(page)).toHaveAttribute("data-style", "bento");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect(root(page)).toHaveAttribute("data-density", "regular");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("vally.theme"))).toBe("bento-light");

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(root(page)).toHaveAttribute("data-style", "bento");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await expect(root(page)).toHaveAttribute("data-density", "regular");

  await page.goto("/market");
  await expect(root(page)).toHaveAttribute("data-style", "bento");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
});
