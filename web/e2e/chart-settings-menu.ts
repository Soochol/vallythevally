import type { Page } from "@playwright/test";
import { expect } from "./harness";

export type SettingsMenu = "봉·축" | "표시" | "지표 창";

export async function chooseSettingsMenu(page: Page, menu: SettingsMenu) {
  const tab = page.getByRole("dialog", { name: "차트 설정", exact: true }).getByRole("tab", { name: menu });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
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
