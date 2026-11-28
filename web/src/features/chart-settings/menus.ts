export const CHART_SETTINGS_SECTIONS = [
  { id: "bars", label: "봉 · 선", description: "차트 봉 모양, 캔들 표시 순서, 종목 범례, 봉 값 등락률, 화면 내 최고·최저가" },
  { id: "axes", label: "축 · 눈금", description: "가격 축 스케일, 가격만 축에 맞춤, 가로·세로 격자선" },
  { id: "time", label: "시간", description: "화면에 보이는 봉 수, 정규장만 보기, 분봉 날짜 구분선" },
] as const satisfies readonly { id: string; label: string; description: string }[];

export type ChartSettingsSectionId = (typeof CHART_SETTINGS_SECTIONS)[number]["id"];
