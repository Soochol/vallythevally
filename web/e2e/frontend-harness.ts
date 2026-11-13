import { test as base, expect } from "@playwright/test";
import { Scenario } from "./fixtures/scenario";
export { DEFAULT_LAYOUT_ID, type Scenario } from "./fixtures/scenario";
export { cell, chartOf, barTimes, dragTowardPast, SEARCH_BUTTON_TITLE } from "./harness";

export const test = base.extend<{ scenario: Scenario }>({
  scenario: async ({ context }, use) => {
    const scenario = new Scenario();
    await scenario.install(context);
    try { await use(scenario); } finally { await scenario.close(); }
  },
});
export { expect };
