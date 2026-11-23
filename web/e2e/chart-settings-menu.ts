import type { Page } from "@playwright/test";
import { expect } from "./harness";

export type SettingsMenu = "봉·축" | "표시" | "지표 창";

export async function chooseSettingsMenu(page: Page, menu: SettingsMenu) {
  const section = page.getByRole("dialog", { name: "차트 설정", exact: true }).getByRole("region", { name: menu, exact: true });
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
}

export async function openChartSettings(page: Page, menu: SettingsMenu = "봉·축") {
  const dialog = page.getByRole("dialog", { name: "차트 설정", exact: true });
  if (!(await dialog.isVisible())) {
    await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "차트 설정", exact: true }).click();
    await expect(dialog).toBeVisible();
  }
  await chooseSettingsMenu(page, menu);
  return dialog;
}
