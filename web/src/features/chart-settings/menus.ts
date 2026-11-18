export const CHART_SETTINGS_MENUS = [
  { id: "bars", label: "봉·축", scope: "cell" },
  { id: "display", label: "표시", scope: "cell" },
  { id: "windows", label: "지표 창", scope: "all" },
] as const;

export type ChartSettingsMenuId = (typeof CHART_SETTINGS_MENUS)[number]["id"];

export const FIRST_CHART_SETTINGS_MENU: ChartSettingsMenuId = "bars";

export function menuAfterKey(current: ChartSettingsMenuId, key: string): ChartSettingsMenuId | null {
  const ids = CHART_SETTINGS_MENUS.map((m) => m.id);
  const at = ids.indexOf(current);
  switch (key) {
    case "ArrowDown":
      return ids[Math.min(ids.length - 1, at + 1)]!;
    case "ArrowUp":
      return ids[Math.max(0, at - 1)]!;
    case "Home":
      return ids[0]!;
    case "End":
      return ids.at(-1)!;
    default:
      return null;
  }
}
