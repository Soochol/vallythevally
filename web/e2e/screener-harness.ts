import { test as base } from "./frontend-harness";
import { screenerScenario, type ScreenerScenario } from "./fixtures/screener";
export { cell, chartOf, DEFAULT_LAYOUT_ID, expect, SEARCH_BUTTON_TITLE, type Scenario } from "./frontend-harness";

export const test = base.extend<{ screener: ScreenerScenario }>({
  screener: [async ({ scenario }, use) => { await use(screenerScenario(scenario)); }, { auto: true }],
});
