import { expect, type Locator } from "@playwright/test";
type Choice = string | { label: string } | { index: number };
export async function selectOption(trigger: Locator, choice: Choice, options?: { timeout?: number }) {
  const name = await trigger.getAttribute("aria-label");
  await trigger.click(options);
  const menu = trigger.page().getByRole("menu", name ? { name, exact: true } : {});
  if (typeof choice === "string") await menu.locator(`[data-option-value="${choice}"]`).click(options);
  else if ("label" in choice) await menu.getByRole("menuitemradio", { name: choice.label, exact: true }).click(options);
  else await menu.getByRole("menuitemradio").nth(choice.index).click(options);
}
export async function selectMinute(trigger: Locator, choice: Choice, options?: { timeout?: number }) {
  if (await trigger.getAttribute("aria-pressed") !== "true") {
    await trigger.click(options);
    await expect(trigger).toHaveAttribute("aria-pressed", "true", options);
  }
  await selectOption(trigger, choice, options);
}
