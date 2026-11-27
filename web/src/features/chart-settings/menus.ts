export type ChartSettingsScope = "cell" | "all";

export const CHART_SETTINGS_SECTIONS = [
  { id: "bars", label: "봉 · 축", description: "차트 봉 모양, 가격 축 스케일, 화면 봉 수, 정규장 표시", scope: "cell" },
  { id: "display", label: "범례 · 표시", description: "종목 범례, 봉 값 등락률, 화면 내 최고·최저가", scope: "cell" },
  { id: "grid", label: "격자 · 구분선", description: "가로·세로 격자선 및 분봉 날짜 구분선", scope: "cell" },
  { id: "windows", label: "창 · 동작", description: "모든 차트에 공통 적용되는 지표 창 열기 방식", scope: "all" },
] as const satisfies readonly { id: string; label: string; description: string; scope: ChartSettingsScope }[];

export type ChartSettingsSectionId = (typeof CHART_SETTINGS_SECTIONS)[number]["id"];

export const SCOPE_LABEL: Record<ChartSettingsScope, string> = { cell: "이 칸", all: "모든 차트" };

export const scopeTitle = (scope: ChartSettingsScope, cellName: string): string => (scope === "all" ? "모든 차트에 적용" : `${cellName}에 적용`);
