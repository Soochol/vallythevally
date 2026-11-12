import { expect, test } from "vitest";
import type { IndicatorSpec } from "../../api/generated/IndicatorSpec";
import { isFinancial, isFinancialBar, KIND_ORDER, KINDS } from "../../chart/indicators/kinds";
import { addIndicator, DEFAULT_CHART_SETTINGS, type IndicatorConfig } from "../../chart/settings";
import {
  checkForm,
  formFromSpec,
  hasColor,
  matchKinds,
  nextColor,
  panelLabel,
  placeErrors,
  primaryLabel,
  type SpecForm,
  startDraft,
  type Validate,
} from "./indicatorForm";

const pass: Validate = () => ({ ok: true });
const edit = (form: SpecForm, text: Record<string, string>, enabled: Record<string, boolean> = {}): SpecForm => ({
  ...form,
  text: { ...form.text, ...text },
  enabled: { ...form.enabled, ...enabled },
});
const specOf = (form: SpecForm) => checkForm(form, pass).spec;

test("종류마다 기본값을 입력으로 바꿨다가 그대로 읽는다", () => {
  for (const kind of KIND_ORDER) expect(specOf(formFromSpec(KINDS[kind].defaults))).toEqual(KINDS[kind].defaults);
  const specs: IndicatorSpec[] = [
    { kind: "ma", method: "ema", period: 60 },
    { kind: "bollinger", period: 10, k: 2.5 },
    { kind: "ichimoku", conversion: 7, base: 22, spanB: 44, displacement: 22 },
    { kind: "volume", maPeriod: null },
    { kind: "rsi", period: 9, signal: 6 },
    { kind: "macd", fast: 5, slow: 35, signal: 5 },
    { kind: "stochSlow", k: 14, d: 3, smooth: 3 },
  ];
  for (const spec of specs) expect(specOf(formFromSpec(spec))).toEqual(spec);
});

test("꺼진 선택 칸은 null이고, 켜면 보이던 값을 쓴다", () => {
  const volume = formFromSpec({ kind: "volume", maPeriod: null });
  expect(volume).toEqual({ kind: "volume", text: { maPeriod: "20" }, enabled: { maPeriod: false } });
  expect(specOf(edit(volume, {}, { maPeriod: true }))).toEqual({ kind: "volume", maPeriod: 20 });

  const rsi = formFromSpec(KINDS.rsi.defaults);
  expect(rsi.enabled.signal).toBe(false);
  expect(specOf(edit(rsi, {}, { signal: true }))).toEqual({ kind: "rsi", period: 14, signal: 9 });
  expect(specOf(edit(rsi, { signal: "엉망" }))).toEqual({ kind: "rsi", period: 14, signal: null });
});

test("친 글자를 읽는다: 앞뒤 공백, 계산 방식, 실수", () => {
  const ma = formFromSpec(KINDS.ma.defaults);
  expect(specOf(edit(ma, { period: " 120 ", method: "ema" }))).toEqual({ kind: "ma", method: "ema", period: 120 });
  expect(specOf(edit(formFromSpec(KINDS.bollinger.defaults), { k: "1.5" }))).toEqual({ kind: "bollinger", period: 20, k: 1.5 });
});

test("정수 칸의 소수·빈칸·음수·글자, 켠 선택 칸의 빈칸은 wasm에 보내기 전에 막는다", () => {
  let called = 0;
  const spy: Validate = () => (called++, { ok: true });
  const ma = formFromSpec(KINDS.ma.defaults);
  for (const bad of ["2.5", "", "-3", "abc", "1e2"]) {
    expect(checkForm(edit(ma, { period: bad }), spy)).toEqual({
      ok: false,
      spec: null,
      errors: [{ field: "period", message: "1 이상의 정수여야 합니다." }],
    });
  }
  const volumeOn = edit(formFromSpec(KINDS.volume.defaults), { maPeriod: "" });
  expect(checkForm(volumeOn, spy).errors).toEqual([{ field: "maPeriod", message: "1 이상의 정수여야 합니다." }]);
  for (const bad of ["", "x", "1e400"]) {
    expect(checkForm(edit(formFromSpec(KINDS.bollinger.defaults), { k: bad }), spy).errors).toEqual([{ field: "k", message: "숫자여야 합니다." }]);
  }
  expect(called).toBe(0);
});

test("검사기가 없으면 통과시키지 않고, 검사기의 오류를 그대로 돌려준다", () => {
  const macd = formFromSpec(KINDS.macd.defaults);
  expect(checkForm(macd, null)).toEqual({ ok: false, spec: KINDS.macd.defaults, errors: [] });
  const errors = [{ field: "slow", message: "fast보다 커야 합니다." }];
  expect(checkForm(macd, () => ({ ok: false, errors }))).toEqual({ ok: false, spec: KINDS.macd.defaults, errors });
  expect(checkForm(macd, pass)).toEqual({ ok: true, spec: KINDS.macd.defaults, errors: [] });
});

test("입력칸과 맞지 않는 오류는 설정 묶음 맨 아래로 간다", () => {
  const placed = placeErrors("macd", [
    { field: "slow", message: "fast보다 커야 합니다." },
    { field: "slow", message: "1 이상이어야 합니다." },
    { field: "", message: "지표 설정을 읽을 수 없습니다: 65536" },
    { field: "period", message: "MACD에는 없는 칸" },
  ]);
  expect(placed).toEqual({
    byField: { slow: ["fast보다 커야 합니다.", "1 이상이어야 합니다."] },
    rest: ["지표 설정을 읽을 수 없습니다: 65536", "MACD에는 없는 칸"],
  });
});

test("색 견본은 색을 고를 선이 있을 때만 보인다", () => {
  const volume = formFromSpec(KINDS.volume.defaults);
  expect(hasColor(volume)).toBe(true);
  expect(hasColor(edit(volume, {}, { maPeriod: false }))).toBe(false);
  expect(hasColor(edit(volume, { maPeriod: "" }))).toBe(true);
  for (const kind of KIND_ORDER.filter((k) => { const spec = KINDS[k].defaults; return k !== "volume" && !(isFinancial(spec) && isFinancialBar(spec.kind)); })) expect(hasColor(formFromSpec(KINDS[kind].defaults))).toBe(true);
});

test("이름과 초성으로 지표 종류를 찾는다", () => {
  expect(matchKinds("")).toEqual(KIND_ORDER);
  expect(matchKinds("ㅇㄷ")).toEqual(["ma"]);
  expect(matchKinds("ㅇ")).toEqual(["ma", "ichimoku", "stochSlow", "revenue", "operating_income", "debt_ratio"]);
  expect(matchKinds("ㅇㅁ")).toEqual(["ichimoku"]);
  expect(matchKinds("ㅅㅌ")).toEqual(["stochSlow"]);
  expect(matchKinds(" 볼린저밴드 ")).toEqual(["bollinger"]);
  expect(matchKinds("macd")).toEqual(["macd"]);
  expect(matchKinds("평균")).toEqual(["ma"]);
  expect(matchKinds("없는 지표")).toEqual([]);
});

test("주 버튼은 무엇이 추가될지를 말하고, 편집이면 변경 적용이다", () => {
  expect(primaryLabel(false, "ma", { kind: "ma", method: "sma", period: 20 })).toBe("이동평균 단순 20 추가");
  expect(primaryLabel(false, "rsi", { kind: "rsi", period: 14, signal: 9 })).toBe("RSI 14 9 추가");
  expect(primaryLabel(false, "macd", null)).toBe("MACD 추가");
  expect(primaryLabel(true, "ma", { kind: "ma", method: "sma", period: 20 })).toBe("변경 적용");
});

test("패널 이름은 가격 패널이거나 지표 패널 순서다", () => {
  let n = 0;
  const id = () => `id-${++n}`;
  const style: IndicatorConfig["style"] = { colors: ["ind-2"], width: 1 };
  const withRsi = addIndicator(DEFAULT_CHART_SETTINGS, { kind: "rsi", period: 14, signal: null }, style, id).settings;
  const withMa = addIndicator(withRsi, { kind: "ma", method: "sma", period: 5 }, style, id).settings;
  expect(withMa.indicators.map((i) => panelLabel(withMa.panels, i.panel))).toEqual(["지표 패널 1", "지표 패널 2", "가격 패널"]);
});

test("편집은 그 지표의 설정과 모양으로, 추가는 기본값과 자동 색으로 시작한다", () => {
  const editing: IndicatorConfig = {
    id: "x",
    spec: { kind: "volume", maPeriod: 60 },
    panel: "p",
    visible: true,
    style: { colors: ["ind-2", "ind-4"], width: 2 },
  };
  expect(startDraft(editing, "ma")).toEqual({ form: { kind: "volume", text: { maPeriod: "60" }, enabled: { maPeriod: true } }, color: "ind-4", width: 2 });
  expect(startDraft(null, "macd")).toEqual({ form: formFromSpec(KINDS.macd.defaults), color: "auto", width: 1 });
});

test("새 지표의 색은 이 칸에서 아직 쓰지 않은 첫 색이다", () => {
  expect(nextColor(DEFAULT_CHART_SETTINGS.indicators)).toBe("ind-2");
  const withMa = addIndicator(DEFAULT_CHART_SETTINGS, { kind: "ma", method: "sma", period: 5 }, { colors: ["ind-2"], width: 1 }).settings;
  expect(nextColor(withMa.indicators)).toBe("ind-3");
});
