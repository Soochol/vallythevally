export type ChartSettingsScope = "cell" | "all";

export const CHART_SETTINGS_SECTIONS = [
  { id: "bars", label: "봉·축", scope: "cell" },
  { id: "display", label: "표시", scope: "cell" },
  { id: "windows", label: "지표 창", scope: "all" },
] as const satisfies readonly { id: string; label: string; scope: ChartSettingsScope }[];

export type ChartSettingsSectionId = (typeof CHART_SETTINGS_SECTIONS)[number]["id"];

export const SCOPE_LABEL: Record<ChartSettingsScope, string> = { cell: "이 칸", all: "모든 차트" };

export const scopeTitle = (scope: ChartSettingsScope, cellName: string): string => (scope === "all" ? "모든 차트에 적용" : `${cellName}에 적용`);
