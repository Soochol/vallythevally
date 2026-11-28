import type { Locator, Page } from "@playwright/test";
import { expect } from "./harness";

const toolbar = (page: Page): Locator => page.getByRole("toolbar", { name: "차트 도구 막대" });

export const addDialog = (page: Page): Locator => page.getByRole("dialog", { name: "지표 더하기", exact: true });
export const addInput = (page: Page): Locator => addDialog(page).getByRole("combobox", { name: "지표·비교 찾기" });
export const kindOption = (page: Page, label: string): Locator => addDialog(page).getByRole("option", { name: label, exact: true });

export async function openAdd(page: Page): Promise<Locator> {
  if (!(await addDialog(page).isVisible())) await toolbar(page).getByRole("button", { name: "지표", exact: true }).click();
  await expect(addDialog(page)).toBeVisible();
  return addDialog(page);
}

export async function closeAdd(page: Page): Promise<void> {
  await addInput(page).press("Escape");
  await expect(addDialog(page)).toBeHidden();
}

export async function switchOn(page: Page, label: string): Promise<void> {
  await openAdd(page);
  await addInput(page).fill(label);
  await kindOption(page, label).click();
  await expect(kindOption(page, label)).toHaveAttribute("aria-selected", "true");
}

export async function addTyped(page: Page, query: string): Promise<void> {
  await openAdd(page);
  await addInput(page).fill(query);
  await addInput(page).press("Enter");
  await expect(addInput(page)).toHaveValue("");
}

export async function openCompare(page: Page): Promise<Locator> {
  const dialog = await openAdd(page);
  await dialog.getByRole("button", { name: "종목 비교", exact: true }).click();
  await expect(dialog.getByRole("listbox", { name: "비교 종목" })).toBeVisible();
  return dialog;
}

export const indicatorBubble = (page: Page, name: string | RegExp): Locator => page.getByRole("dialog", { name });

export async function openPanelPlace(page: Page, rowId: string): Promise<Locator> {
  await page.locator(`[data-indicator-row="${rowId}"] [data-indicator-edit]`).click();
  const bubble = page.getByRole("dialog", { name: /설정$/ });
  await expect(bubble).toBeVisible();
  const toggle = bubble.getByRole("button", { name: /자세히/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return bubble;
}
