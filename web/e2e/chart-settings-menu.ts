import type { Page } from "@playwright/test";
import { expect } from "./harness";

export type SettingsMenu = "봉 · 선" | "축 · 눈금" | "시간" | "봉·선" | "축·눈금";

const MENU_ALIAS: Record<SettingsMenu, "봉 · 선" | "축 · 눈금" | "시간"> = {
  "봉 · 선": "봉 · 선",
  "축 · 눈금": "축 · 눈금",
  "시간": "시간",
  "봉·선": "봉 · 선",
  "축·눈금": "축 · 눈금",
};

export async function chooseSettingsMenu(page: Page, menu: SettingsMenu) {
  const target = MENU_ALIAS[menu];
  const dialog = page.getByRole("dialog", { name: "차트 설정", exact: true });
  await dialog.getByRole("tab", { name: target, exact: true }).click();
  await expect(dialog.getByRole("region", { name: target, exact: true })).toBeVisible();
}

export async function openChartSettings(page: Page, menu: SettingsMenu = "봉 · 선") {
  const dialog = page.getByRole("dialog", { name: "차트 설정", exact: true });
  if (!(await dialog.isVisible())) {
    await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "차트 설정", exact: true }).click();
    await expect(dialog).toBeVisible();
  }
  await chooseSettingsMenu(page, menu);
  return dialog;
}
