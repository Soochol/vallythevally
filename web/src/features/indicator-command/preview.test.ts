import { expect, test } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "../../chart/settings";
import { previewSettings } from "./preview";

test("추가 미리보기는 저장 설정을 고치지 않고 임시 패널을 사용한다", () => {
  const saved = structuredClone(DEFAULT_CHART_SETTINGS);
  const shown = previewSettings(saved, { kind: "add", id: "preview", panelId: "preview-pane", spec: { kind: "rsi", period: 20, signal: null }, style: { colors: ["ind-2"], width: 5 } });
  expect(saved).toEqual(DEFAULT_CHART_SETTINGS);
  expect(shown.indicators.at(-1)).toMatchObject({ id: "preview", panel: "preview-pane", spec: { kind: "rsi", period: 20 } });
  expect(shown.panels.at(-1)?.id).toBe("preview-pane");
  expect(previewSettings(saved, null)).toBe(saved);
});

test("기존 지표 미리보기도 원본 설정과 표시 여부를 보존한다", () => {
  const saved = structuredClone(DEFAULT_CHART_SETTINGS);
  const current = saved.indicators[0]!;
  const shown = previewSettings(saved, { kind: "edit", id: current.id, spec: { kind: "volume", maPeriod: 60 }, style: { colors: ["ind-3"], width: 3 } });
  expect(shown.indicators).toHaveLength(saved.indicators.length);
  expect(shown.indicators[0]).toMatchObject({ spec: { kind: "volume", maPeriod: 60 }, visible: current.visible });
  expect(saved).toEqual(DEFAULT_CHART_SETTINGS);
});
