export const CHART_SETTINGS_SECTIONS = [
  { id: "bars", label: "봉 · 축", description: "차트 봉 모양, 가격 축 스케일, 가격만 축에 맞춤, 화면 봉 수, 정규장 표시" },
  { id: "display", label: "범례 · 표시", description: "종목 범례, 봉 값 등락률, 화면 내 최고·최저가, 캔들 표시 순서" },
  { id: "grid", label: "격자 · 구분선", description: "가로·세로 격자선 및 분봉 날짜 구분선" },
] as const satisfies readonly { id: string; label: string; description: string }[];

export type ChartSettingsSectionId = (typeof CHART_SETTINGS_SECTIONS)[number]["id"];
