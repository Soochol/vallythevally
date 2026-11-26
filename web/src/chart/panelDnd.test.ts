import { expect, test } from "vitest";
import { resolveDropTarget } from "./panelDnd";
import type { IndicatorConfig, Panel } from "./settings";

const style = { colors: ["ind-1" as const], width: 1 as const };
const PANELS: Panel[] = [
  { id: "p-vol", stretch: 0.25 },
  { id: "p-rsi", stretch: 0.25 },
  { id: "p-macd", stretch: 0.25 },
];
const CONFIGS: IndicatorConfig[] = [
  { id: "vol", spec: { kind: "volume", maPeriod: 20 }, panel: "p-vol", visible: true, style },
  { id: "rsi", spec: { kind: "rsi", period: 14, signal: null }, panel: "p-rsi", visible: true, style },
  { id: "macd", spec: { kind: "macd", fast: 12, slow: 26, signal: 9 }, panel: "p-macd", visible: true, style },
];
const PANES = [
  { top: 0, height: 300 },
  { top: 300, height: 100 },
  { top: 400, height: 100 },
  { top: 500, height: 100 },
];

test("패널 중앙 드롭은 합치기 대상과 자동 Y축 배정 태그를 돌려준다", () => {
  const hit = resolveDropTarget({ x: 200, y: 350, width: 800, height: 600, draggedId: "rsi", configs: CONFIGS, panels: PANELS, panes: PANES });
  expect(hit).toMatchObject({ kind: "merge", panelId: "p-vol", blocked: false, tag: "좌측 Y축(L) 자동 배정" });
});

test("자기 자신이 속한 패널 중앙에 올려놓으면 아무 동작도 하지 않는다", () => {
  expect(resolveDropTarget({ x: 200, y: 450, width: 800, height: 600, draggedId: "rsi", configs: CONFIGS, panels: PANELS, panes: PANES })).toBeNull();
});

test("상단·하단 경계선 22% 영역은 분리 또는 패널 이동 삽입선을 반환한다", () => {
  const topEdge = resolveDropTarget({ x: 200, y: 310, width: 800, height: 600, draggedId: "macd", configs: CONFIGS, panels: PANELS, panes: PANES });
  expect(topEdge).toMatchObject({ kind: "split", insertAt: 0, lineY: 300, label: "여기로 패널 이동" });

  const mergedConfigs = CONFIGS.map((c) => c.id === "rsi" ? { ...c, panel: "p-vol" } : c);
  const mergedPanels = [PANELS[0]!, PANELS[2]!];
  const mergedPanes = [PANES[0]!, PANES[1]!, PANES[2]!];
  const bottomEdge = resolveDropTarget({ x: 200, y: 390, width: 800, height: 500, draggedId: "rsi", configs: mergedConfigs, panels: mergedPanels, panes: mergedPanes });
  expect(bottomEdge).toMatchObject({ kind: "split", insertAt: 1, lineY: 400, label: "여기에 새 패널로 분리" });
});

test("가격 패널 중앙에는 거래량만 겹칠 수 있고 다른 지표는 차단 표시를 반환한다", () => {
  const volHit = resolveDropTarget({ x: 200, y: 120, width: 800, height: 600, draggedId: "vol", configs: CONFIGS, panels: PANELS, panes: PANES });
  expect(volHit).toMatchObject({ kind: "merge", panelId: "price", blocked: false, tag: "거래량 겹치기" });

  const rsiHit = resolveDropTarget({ x: 200, y: 120, width: 800, height: 600, draggedId: "rsi", configs: CONFIGS, panels: PANELS, panes: PANES });
  expect(rsiHit).toMatchObject({ kind: "merge", panelId: "price", blocked: true });
});

test("차트 영역 밖 좌표는 null을 돌려준다", () => {
  expect(resolveDropTarget({ x: -50, y: 350, width: 800, height: 600, draggedId: "rsi", configs: CONFIGS, panels: PANELS, panes: PANES })).toBeNull();
});
