import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { colorsFrom } from "../../chart/indicators/kinds";
import { parseChartSettings, shownScale } from "../../chart/settings";
import { startAutosave, type Autosave } from "../../persist/autosave";
import { DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import init, { validateSpec } from "../../wasm/indicators/indicators.js";
import { checkForm } from "../indicator-dialog/indicatorForm";
import { executeCommand } from "./execute";
import { parseIndicatorInput } from "./parseInput";
import { previewSettings, useIndicatorPreview } from "./preview";

let autosave: Autosave;
let puts: unknown[];
const settings = () => useLayoutStore.getState().layout.cells[0]!.chartSettings;

beforeAll(async () => {
  await init({ module_or_path: await readFile(new URL("../../wasm/indicators/indicators_bg.wasm", import.meta.url)) });
});
beforeEach(() => {
  vi.useFakeTimers();
  puts = [];
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  useIndicatorPreview.getState().set(0, null);
  autosave = startAutosave({ put: async (_, json) => { puts.push(JSON.parse(json)); }, toast: () => {}, revisions: { layout: 0, ui: 0, watchlist: 0 }, unsaved: () => undefined });
});
afterEach(() => { autosave.stop(); useIndicatorPreview.getState().set(0, null); vi.useRealTimers(); });

function add(input: string) {
  const candidate = parseIndicatorInput(input)[0];
  if (!candidate) throw new Error("추가 후보가 없습니다");
  expect(candidate.errors).toEqual([]);
  const checked = checkForm(candidate.form, (spec) => validateSpec(JSON.stringify(spec)));
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  expect(executeCommand(0, { kind: "indicator", id: null, spec: checked.spec, style: { colors: colorsFrom(checked.spec, "ind-2"), width: 1 } })).toBe(true);
}

test("입력으로 여러 지표를 계속 추가하고 확정한 설정만 저장·복원한다", async () => {
  for (const input of ["이평 20", "bb 20 2", "rsi", "이평 20"]) add(input);
  expect(settings().indicators.map((config) => config.spec.kind)).toEqual(["volume", "ma", "bollinger", "rsi", "ma"]);
  await vi.advanceTimersByTimeAsync(1100);
  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({ cells: [{ chartSettings: { indicators: [{ spec: { kind: "volume" } }, { spec: { kind: "ma", period: 20 } }, { spec: { kind: "bollinger", period: 20, k: 2 } }, { spec: { kind: "rsi", period: 14 } }, { spec: { kind: "ma", period: 20 } }] } }] });
  expect(parseChartSettings(JSON.parse(JSON.stringify(settings())))).toEqual(settings());
});

test("추가·편집 미리보기를 취소하면 원본 설정으로 돌아가고 autosave는 호출하지 않는다", async () => {
  const original = structuredClone(settings());
  const preview = { kind: "add", id: "preview", panelId: "preview-pane", spec: { kind: "ma", method: "sma", period: 9 }, style: { colors: ["ind-2"], width: 5 } } as const;
  useIndicatorPreview.getState().set(0, { ...preview, style: { colors: ["ind-2"], width: 5 } });
  expect(previewSettings(settings(), useIndicatorPreview.getState().current!.preview).indicators.at(-1)?.spec).toEqual(preview.spec);
  await vi.advanceTimersByTimeAsync(5000);
  const current = settings().indicators[0]!;
  useIndicatorPreview.getState().set(0, { kind: "edit", id: current.id, spec: { kind: "volume", maPeriod: 60 }, style: { colors: ["ind-3"], width: 3 } });
  expect(previewSettings(settings(), useIndicatorPreview.getState().current!.preview).indicators[0]?.spec).toEqual({ kind: "volume", maPeriod: 60 });
  useIndicatorPreview.getState().set(0, null);
  await vi.advanceTimersByTimeAsync(5000);
  expect(previewSettings(settings(), null)).toEqual(original);
  expect(settings()).toEqual(original);
  expect(puts).toEqual([]);
});

test("띄운 지표를 숨기고 지워도 나머지 지표와 패널은 보존한다", async () => {
  add("이평 5");
  const id = settings().indicators.at(-1)!.id;
  useLayoutStore.getState().updateIndicator(0, id, { visible: false });
  expect(settings().indicators.at(-1)?.visible).toBe(false);
  useLayoutStore.getState().removeIndicator(0, id);
  await vi.advanceTimersByTimeAsync(1100);
  expect(settings()).toEqual(DEFAULT_LAYOUT.cells[0]!.chartSettings);
  expect(puts).toHaveLength(1);
});

test("비교 종목 추가는 중복·현재 종목·4번째를 막고 % 축과 저장 복원을 유지한다", async () => {
  for (const code of ["005930", "000660", "006400"]) expect(executeCommand(0, { kind: "compare", code })).toBe(true);
  for (const code of ["005930", "IDX:001", "035420"]) expect(executeCommand(0, { kind: "compare", code })).toBe(false);
  expect(shownScale(settings())).toBe("percent");
  expect(settings().compare).toEqual(["005930", "000660", "006400"]);
  await vi.advanceTimersByTimeAsync(1100);
  expect(puts).toHaveLength(1);
  expect(parseChartSettings(JSON.parse(JSON.stringify(settings()))).compare).toEqual(settings().compare);
});

test("편집 확정은 기존 id에만 적용하고 삭제된 지표를 다시 만들지 않는다", () => {
  add("이평 5");
  const id = settings().indicators.at(-1)!.id;
  expect(executeCommand(0, { kind: "indicator", id, spec: { kind: "ma", method: "sma", period: 9 }, style: { colors: ["ind-4"], width: 5 } })).toBe(true);
  expect(settings().indicators.at(-1)).toMatchObject({ id, spec: { kind: "ma", period: 9 }, style: { width: 5 } });
  useLayoutStore.getState().removeIndicator(0, id);
  expect(executeCommand(0, { kind: "indicator", id, spec: { kind: "ma", method: "sma", period: 12 }, style: { colors: ["ind-4"], width: 5 } })).toBe(false);
  expect(settings().indicators).toHaveLength(1);
});
