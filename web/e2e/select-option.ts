import type { Locator } from "@playwright/test";
export async function selectOption(trigger: Locator, choice: string | { label: string } | { index: number }, options?: { timeout?: number }) {
  const name = await trigger.getAttribute("aria-label");
  await trigger.click(options);
  const menu = trigger.page().getByRole("menu", name ? { name, exact: true } : {});
  if (typeof choice === "string") await menu.locator(`[data-option-value="${choice}"]`).click(options);
  else if ("label" in choice) await menu.getByRole("menuitemradio", { name: choice.label, exact: true }).click(options);
  else await menu.getByRole("menuitemradio").nth(choice.index).click(options);
}
