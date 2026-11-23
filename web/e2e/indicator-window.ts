import type { Scenario } from "./harness";

export function useCenterIndicatorWindow(scenario: Scenario): void {
  const saved = scenario.documents.uiState();
  if (saved.indicatorWindow === undefined) scenario.documents.saveUiState({ ...saved, indicatorWindow: "dialog" });
}
