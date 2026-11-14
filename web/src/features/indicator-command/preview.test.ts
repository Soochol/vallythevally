import { expect, test } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "../../chart/settings";
import { previewSettings } from "./preview";

test("추가 미리보기는 저장 설정을 고치지 않고 임시 패널을 사용한다", () => {
  const saved = structuredClone(DEFAULT_CHART_SETTINGS);
  const shown = previewSettings(saved, { kind: "add", id: "preview", panelId: "preview-pane", spec: { kind: "rsi", period: 20, signal: null }, style: { colors: ["ind-2"], width: 5 }, placement: "panel" });
  expect(saved).toEqual(DEFAULT_CHART_SETTINGS);
  expect(shown.indicators.at(-1)).toMatchObject({ id: "preview", panel: "preview-pane", spec: { kind: "rsi", period: 20 } });
  expect(shown.panels.at(-1)?.id).toBe("preview-pane");
  expect(previewSettings(saved, null)).toBe(saved);
});

test("기존 지표 미리보기도 원본 설정과 표시 여부를 보존한다", () => {
  const saved = structuredClone(DEFAULT_CHART_SETTINGS);
  const current = saved.indicators[0]!;
  const shown = previewSettings(saved, { kind: "edit", id: current.id, panelId: "unused", spec: { kind: "volume", maPeriod: 60 }, style: { colors: ["ind-3"], width: 3 }, placement: "panel" });
  expect(shown.indicators).toHaveLength(saved.indicators.length);
  expect(shown.indicators[0]).toMatchObject({ spec: { kind: "volume", maPeriod: 60 }, visible: current.visible });
  expect(saved).toEqual(DEFAULT_CHART_SETTINGS);
});

test("거래량 미리보기는 고른 자리와 불투명도로 그린다", () => {
  const saved = structuredClone(DEFAULT_CHART_SETTINGS);
  const style = { colors: ["ind-2" as const], width: 1 as const, barOpacity: 0.7 };
  const added = previewSettings(saved, { kind: "add", id: "preview", panelId: "preview-pane", spec: { kind: "volume", maPeriod: null }, style, placement: "price" });
  expect(added.indicators.at(-1)).toMatchObject({ id: "preview", panel: "price", style });
  expect(added.panels).toEqual(saved.panels);
  const current = saved.indicators[0]!;
  const moved = previewSettings(saved, { kind: "edit", id: current.id, panelId: "preview-pane", spec: current.spec, style, placement: "price" });
  expect(moved.indicators[0]).toMatchObject({ id: current.id, panel: "price", style });
  expect(moved.panels).toEqual([]);
  expect(saved).toEqual(DEFAULT_CHART_SETTINGS);
});
