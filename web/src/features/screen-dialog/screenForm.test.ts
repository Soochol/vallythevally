import { expect, test } from "vitest";
import type { Condition } from "../../api/generated/Condition";
import type { Screen } from "../../api/generated/Screen";
import type { ConditionKind } from "../../lib/screener";
import {
  addCondition,
  addMaLine,
  changeKind,
  type ConditionDraft,
  type ConditionErrors,
  checkCondition,
  checkDraft,
  draftOf,
  editCondition,
  excludesIn,
  KIND_GROUPS,
  moveCondition,
  removeCondition,
  removeMaLine,
  type ScreenDraft,
  toggleExclude,
  toggleMarket,
  withScreen,
} from "./screenForm";

const weekly: Screen = {
  id: "s1",
  name: "52주 신고가와 신고거래량",
  markets: [],
  exclude: ["etf", "trading_halted"],
  conditions: [
    { kind: "new_high", period: "W", m: 1, field: "high", n: 52 },
    { kind: "new_high", period: "W", m: 4, field: "volume", n: 52 },
  ],
};
const many = (count: number): Screen[] => Array.from({ length: count }, (_, i) => ({ ...weekly, id: `s${i + 1}` }));
const errorsOf = (draft: ScreenDraft, id = "new", saved: readonly Screen[] = []) => {
  const check = checkDraft(draft, id, saved);
  if (check.ok) throw new Error("검사를 통과하면 안 된다");
  return check.errors;
};
const named = (draft: ScreenDraft): ScreenDraft => ({ ...draft, name: "시험" });
const firstLine = (draft: ScreenDraft): ConditionDraft => draft.conditions[0]!;
const oneLine = (): ScreenDraft => addCondition(draftOf(null));
const lineOf = (condition: Condition): ConditionDraft => firstLine(draftOf({ ...weekly, conditions: [condition] }));
const conditionOf = (line: ConditionDraft): Condition => {
  const row = checkCondition(line);
  if (!row.ok) throw new Error(`검사를 통과해야 한다: ${JSON.stringify(row.errors)}`);
  return row.condition;
};
const errorsIn = (line: ConditionDraft): ConditionErrors => {
  const row = checkCondition(line);
  if (row.ok) throw new Error("조건 검사를 통과하면 안 된다");
  expect(checkDraft(named({ ...draftOf(null), conditions: [line] }), "new", []).ok).toBe(false);
  return row.errors;
};
const asKind = <K extends ConditionKind>(kind: K, period: ConditionDraft["period"] = "D", m = "1") => {
  const line = firstLine(changeKind(oneLine(), 0, kind));
  if (line.kind !== kind) throw new Error("종류가 바뀌어야 한다");
  return { ...line, period, m } as Extract<ConditionDraft, { kind: K }>;
};

test("새 조건식은 이름이 비면 이름 칸에 이유를 달고 막는다", () => {
  expect(errorsOf(draftOf(null))).toEqual({ name: "이름을 넣으세요", list: null });
  expect(errorsOf({ ...draftOf(null), name: "   " }).name).toBe("이름을 넣으세요");
});

test("이름은 앞뒤 공백을 빼고 40자까지다", () => {
  expect(errorsOf({ ...draftOf(null), name: "가".repeat(41) }).name).toBe("이름은 40자까지입니다 (지금 41자)");
  const check = checkDraft({ ...draftOf(null), name: `  ${"가".repeat(40)}  ` }, "new", []);
  expect(check.ok && check.screen.name).toBe("가".repeat(40));
});

test("새 조건식은 조건 0줄로 시작해 그대로 저장할 수 있고, 처음 더한 줄은 일봉 고가 200일 신고가, 최근 1일이다", () => {
  expect(draftOf(null).conditions).toEqual([]);
  expect(checkDraft(named(draftOf(null)), "id-1", [])).toEqual({ ok: true, screen: { id: "id-1", name: "시험", markets: [], exclude: [], conditions: [] } });
  const check = checkDraft(named(oneLine()), "id-1", []);
  expect(check.ok && check.screen.conditions).toEqual([{ kind: "new_high", period: "D", m: 1, field: "high", n: 200 }]);
});

test("조건 0줄로 저장한 조건식을 다시 열면 0줄이고, 이름만 바꿔 저장해도 0줄이다", () => {
  const saved: Screen = { id: "s0", name: "코스닥 전체", markets: ["kosdaq"], exclude: ["managed"], conditions: [] };
  expect(draftOf(saved)).toEqual({ name: "코스닥 전체", conditions: [], markets: ["kosdaq"], exclude: ["managed"] });
  expect(checkDraft({ ...draftOf(saved), name: "코스닥 관리 제외" }, "s0", [saved])).toEqual({ ok: true, screen: { ...saved, name: "코스닥 관리 제외" } });
});

test("더한 줄은 윗줄의 봉 주기만 따르고 나머지는 신고가 기본값이다", () => {
  let draft = draftOf({ ...weekly, conditions: [{ kind: "rsi", period: "M", m: 3, length: 9, test: { kind: "range", min: 10, max: 20 } }] });
  draft = addCondition(draft);
  expect(conditionOf(draft.conditions[1]!)).toEqual({ kind: "new_high", period: "M", m: 1, field: "high", n: 200 });
  draft = addCondition(editCondition(draft, { ...draft.conditions[1]!, period: "W" }));
  expect(conditionOf(draft.conditions[2]!)).toEqual({ kind: "new_high", period: "W", m: 1, field: "high", n: 200 });
});

test("시가총액 줄 아래에 더한 줄은 시가총액 줄이 이어 받은 봉 주기를 따른다", () => {
  const draft = addCondition(draftOf({ ...weekly, conditions: [weekly.conditions[0]!, { kind: "market_cap", min: 300_000_000_000, max: null }] }));
  expect(conditionOf(draft.conditions[2]!)).toEqual({ kind: "new_high", period: "W", m: 1, field: "high", n: 200 });
});

test("종류를 바꾸면 봉 주기와 M은 남고 나머지는 그 종류의 기본값이며, 지표 기본값은 차트와 같다", () => {
  const start = editCondition(oneLine(), { ...firstLine(oneLine()), period: "W", m: "3" });
  const expected: Record<ConditionKind, Condition> = {
    new_high: { kind: "new_high", period: "W", m: 3, field: "high", n: 200 },
    new_low: { kind: "new_low", period: "W", m: 3, field: "low", n: 200 },
    value_range: { kind: "value_range", period: "W", m: 3, field: "traded_value", min: 10_000_000_000, max: null },
    change: { kind: "change", period: "W", m: 3, back: 1, minPct: 5, maxPct: null },
    near_extreme: { kind: "near_extreme", period: "W", m: 3, extreme: "high", n: 200, withinPct: 5 },
    surge: { kind: "surge", period: "W", m: 3, field: "volume", n: 20, times: 3 },
    ma_position: { kind: "ma_position", period: "W", m: 3, field: "close", method: "sma", length: 20, side: "above" },
    ma_alignment: { kind: "ma_alignment", period: "W", m: 3, method: "sma", lengths: [5, 20, 60, 120], order: "bullish" },
    ma_cross: { kind: "ma_cross", period: "W", m: 3, method: "sma", fast: 5, slow: 20, direction: "up" },
    rsi: { kind: "rsi", period: "W", m: 3, length: 14, test: { kind: "range", min: null, max: 30 } },
    macd: { kind: "macd", period: "W", m: 3, fast: 12, slow: 26, signal: 9, test: { kind: "signal_cross", direction: "up" } },
    stochastic: { kind: "stochastic", period: "W", m: 3, k: 5, d: 3, smooth: 3, test: { kind: "cross", direction: "up" } },
    bollinger: { kind: "bollinger", period: "W", m: 3, length: 20, k: 2, test: { kind: "outside", side: "above" } },
    ichimoku: { kind: "ichimoku", period: "W", m: 3, conversion: 9, base: 26, spanB: 52, displacement: 26, test: { kind: "cloud", side: "above" } },
    market_cap: { kind: "market_cap", min: 300_000_000_000, max: null },
  };
  for (const kind of Object.keys(expected) as ConditionKind[]) {
    const changed = changeKind(start, 0, kind);
    expect(conditionOf(firstLine(changed))).toEqual(expected[kind]);
    expect(conditionOf(firstLine(changeKind(changed, 0, "new_high")))).toEqual(expected.new_high);
  }
});

test("같은 종류를 다시 고르면 입력한 값이 그대로다", () => {
  const draft = editCondition(oneLine(), { ...asKind("new_high"), n: "60" });
  expect(changeKind(draft, 0, "new_high")).toEqual(draft);
});

test("종류 메뉴는 가격, 거래, 이동평균, 보조지표, 종목 묶음에 15가지를 한 번씩 담는다", () => {
  expect(KIND_GROUPS.map((g) => [g.label, g.kinds])).toEqual([
    ["가격", ["new_high", "new_low", "value_range", "change", "near_extreme"]],
    ["거래", ["surge"]],
    ["이동평균", ["ma_position", "ma_alignment", "ma_cross"]],
    ["보조지표", ["rsi", "macd", "stochastic", "bollinger", "ichimoku"]],
    ["종목", ["market_cap"]],
  ]);
});

test("▲▼는 이웃한 줄과 자리를 바꾸고, 첫 줄 위와 끝 줄 아래로는 가지 않는다", () => {
  let draft = draftOf({ ...weekly, conditions: [weekly.conditions[0]!, { kind: "market_cap", min: 1, max: null }, weekly.conditions[1]!] });
  const kinds = (d: ScreenDraft) => d.conditions.map((c) => `${c.kind}:${c.key}`);
  expect(kinds(draft)).toEqual(["new_high:0", "market_cap:1", "new_high:2"]);
  draft = moveCondition(draft, 2, -1);
  expect(kinds(draft)).toEqual(["new_high:0", "new_high:2", "market_cap:1"]);
  draft = moveCondition(draft, 0, 1);
  expect(kinds(draft)).toEqual(["new_high:2", "new_high:0", "market_cap:1"]);
  expect(moveCondition(draft, 2, -1)).toEqual(draft);
  expect(moveCondition(draft, 1, 1)).toEqual(draft);
  const check = checkDraft(draft, weekly.id, [weekly]);
  expect(check.ok && check.screen.conditions).toEqual([weekly.conditions[1], weekly.conditions[0], { kind: "market_cap", min: 1, max: null }]);
});

test("M이 N보다 크면 M 칸에 그 줄의 봉 주기 단위로 이유를 단다", () => {
  expect(errorsIn({ ...asKind("new_high"), n: "200", m: "201" })).toEqual({ m: "신고가 기간 200일보다 길 수 없습니다" });
  expect(errorsIn({ ...asKind("new_high", "W"), n: "52", m: "53" })).toEqual({ m: "신고가 기간 52주보다 길 수 없습니다" });
  expect(errorsIn({ ...asKind("new_low", "M"), n: "12", m: "13" })).toEqual({ m: "신저가 기간 12개월보다 길 수 없습니다" });
  expect(conditionOf({ ...asKind("new_low"), n: "200", m: "200" })).toMatchObject({ n: 200, m: 200 });
});

test("N, M, 비교 봉 수는 1 이상의 정수여야 하고, u32 끝까지 받는다", () => {
  for (const bad of ["", "0", "1.5", "-3", "abc", "2e3", "1,00"]) {
    expect(errorsIn({ ...asKind("new_high"), n: bad })).toEqual({ n: "1 이상의 정수를 넣으세요" });
    expect(errorsIn({ ...asKind("near_extreme"), m: bad })).toEqual({ m: "1 이상의 정수를 넣으세요" });
    expect(errorsIn({ ...asKind("change"), back: bad })).toEqual({ back: "1 이상의 정수를 넣으세요" });
  }
  expect(errorsIn({ ...asKind("surge"), n: "4294967296" })).toEqual({ n: "4,294,967,295 이하로 넣으세요" });
  expect(conditionOf({ ...asKind("new_high"), n: " 4294967295 ", m: "1,000" })).toEqual({ kind: "new_high", period: "D", m: 1000, field: "high", n: 4_294_967_295 });
});

test("지표 기간은 차트 지표처럼 1~65,535의 정수다", () => {
  expect(errorsIn({ ...asKind("ma_position"), length: "65536" })).toEqual({ length: "65,535 이하로 넣으세요" });
  expect(errorsIn({ ...asKind("rsi"), length: "0" })).toEqual({ length: "1 이상의 정수를 넣으세요" });
  expect(errorsIn({ ...asKind("stochastic"), k: "", d: "2.5", smooth: "70000" })).toEqual({ k: "1 이상의 정수를 넣으세요", d: "1 이상의 정수를 넣으세요", smooth: "65,535 이하로 넣으세요" });
  expect(errorsIn({ ...asKind("ichimoku"), conversion: "0", base: "x", spanB: "65536", displacement: "" })).toEqual({
    conversion: "1 이상의 정수를 넣으세요",
    base: "1 이상의 정수를 넣으세요",
    spanB: "65,535 이하로 넣으세요",
    displacement: "1 이상의 정수를 넣으세요",
  });
  expect(errorsIn({ ...asKind("macd"), signal: "0" })).toEqual({ signal: "1 이상의 정수를 넣으세요" });
  expect(conditionOf({ ...asKind("ma_position"), length: "65535" })).toMatchObject({ length: 65_535 });
});

test("MACD와 이평 교차는 짧은 쪽이 긴 쪽보다 짧아야 하고, 종가와의 교차는 짧은 쪽을 따지지 않는다", () => {
  expect(errorsIn({ ...asKind("macd"), fast: "26", slow: "26" })).toEqual({ fast: "느린 기간 26일보다 짧아야 합니다" });
  expect(errorsIn({ ...asKind("ma_cross", "W"), fast: "60", slow: "20" })).toEqual({ fast: "긴 이평 20주보다 짧아야 합니다" });
  const close = { ...asKind("ma_cross"), fastLine: "close", fast: "60", slow: "20" } as const;
  expect(conditionOf(close)).toEqual({ kind: "ma_cross", period: "D", m: 1, method: "sma", fast: null, slow: 20, direction: "up" });
  expect(conditionOf({ ...close, fastLine: "ma", fast: "5" })).toMatchObject({ fast: 5, slow: 20 });
});

test("이평 배열은 짧은 것부터 커지는 순서로 겹치지 않아야 하고, 2~5개다", () => {
  const line = asKind("ma_alignment");
  expect(errorsIn({ ...line, lengths: ["5", "20", "20", "120"] })).toEqual({ "lengths.2": "앞 이평 20일보다 길어야 합니다" });
  expect(errorsIn({ ...line, lengths: ["60", "20"] })).toEqual({ "lengths.1": "앞 이평 60일보다 길어야 합니다" });
  expect(errorsIn({ ...line, lengths: ["5", "", "60"] })).toEqual({ "lengths.1": "1 이상의 정수를 넣으세요" });
  let grown = addMaLine(line);
  expect(grown.lengths).toEqual(["5", "20", "60", "120", "240"]);
  expect(addMaLine(grown)).toEqual(grown);
  grown = removeMaLine(removeMaLine(removeMaLine(grown)));
  expect(grown.lengths).toEqual(["5", "20"]);
  expect(removeMaLine(grown)).toEqual(grown);
  expect(conditionOf(grown)).toMatchObject({ lengths: [5, 20] });
});

test("범위는 한 끝 이상이 있어야 하고, 두 끝이 있으면 최소가 최대 이하다", () => {
  expect(errorsIn({ ...asKind("value_range"), min: " ", max: "" })).toEqual({ min: "최소와 최대 가운데 하나는 넣으세요" });
  expect(errorsIn({ ...asKind("change"), minPct: "10", maxPct: "5" })).toEqual({ maxPct: "최소보다 작을 수 없습니다" });
  expect(errorsIn({ ...asKind("market_cap"), min: "", max: "" })).toEqual({ min: "최소와 최대 가운데 하나는 넣으세요" });
  expect(errorsIn({ ...asKind("rsi"), min: "70", max: "30" })).toEqual({ max: "최소보다 작을 수 없습니다" });
  expect(conditionOf({ ...asKind("value_range"), field: "close", min: "1000", max: "1000" })).toMatchObject({ min: 1000, max: 1000 });
  expect(conditionOf({ ...asKind("change"), minPct: "", maxPct: "-3" })).toMatchObject({ minPct: null, maxPct: -3 });
});

test("값 범위와 시가총액은 0 이상, 등락률은 음수도 받는다", () => {
  expect(errorsIn({ ...asKind("value_range"), field: "close", min: "-1" })).toEqual({ min: "0 이상의 수를 넣으세요" });
  expect(errorsIn({ ...asKind("market_cap"), min: "", max: "-0.5" })).toEqual({ max: "0 이상의 수를 넣으세요" });
  expect(errorsIn({ ...asKind("value_range"), min: "1e3" })).toEqual({ min: "숫자를 넣으세요" });
  expect(conditionOf({ ...asKind("change"), minPct: "−10.5", maxPct: "+3" })).toMatchObject({ minPct: -10.5, maxPct: 3 });
  expect(conditionOf({ ...asKind("value_range"), field: "volume", min: "0", max: "1,000,000" })).toMatchObject({ min: 0, max: 1_000_000 });
});

test("거리, RSI·%K 범위, 돌파 값은 0~100이고, 배수와 볼린저 표준편차 배수는 0보다 크다", () => {
  expect(errorsIn({ ...asKind("near_extreme"), withinPct: "100.5" })).toEqual({ withinPct: "0~100 사이의 수를 넣으세요" });
  expect(conditionOf({ ...asKind("near_extreme"), withinPct: "0" })).toMatchObject({ withinPct: 0 });
  expect(errorsIn({ ...asKind("rsi"), min: "-1", max: "101" })).toEqual({ min: "0~100 사이의 수를 넣으세요", max: "0~100 사이의 수를 넣으세요" });
  expect(errorsIn({ ...asKind("rsi"), test: "breakout", value: "120" })).toEqual({ value: "0~100 사이의 수를 넣으세요" });
  expect(errorsIn({ ...asKind("stochastic"), test: "range", min: "", max: "100.1" })).toEqual({ max: "0~100 사이의 수를 넣으세요" });
  expect(errorsIn({ ...asKind("surge"), times: "0" })).toEqual({ times: "0보다 큰 수를 넣으세요" });
  expect(errorsIn({ ...asKind("bollinger"), k: "" })).toEqual({ k: "숫자를 넣으세요" });
  expect(errorsIn({ ...asKind("bollinger"), k: "-2" })).toEqual({ k: "0보다 큰 수를 넣으세요" });
  expect(conditionOf({ ...asKind("bollinger"), k: "0.5" })).toMatchObject({ k: 0.5 });
});

test("판정을 고르면 그 판정의 값만 보내고, 다른 판정의 칸에 넣던 값은 남는다", () => {
  const rsi = { ...asKind("rsi", "W", "2"), min: "10", max: "20", value: "50", direction: "down" } as const;
  expect(conditionOf({ ...rsi, test: "breakout" })).toEqual({ kind: "rsi", period: "W", m: 2, length: 14, test: { kind: "breakout", value: 50, direction: "down" } });
  expect(conditionOf({ ...rsi, test: "range", value: "abc" })).toEqual({ kind: "rsi", period: "W", m: 2, length: 14, test: { kind: "range", min: 10, max: 20 } });
  const macd = { ...asKind("macd"), side: "below", direction: "down" } as const;
  expect(conditionOf({ ...macd, test: "vs_signal" })).toMatchObject({ test: { kind: "vs_signal", side: "below" } });
  expect(conditionOf({ ...macd, test: "zero_breakout" })).toMatchObject({ test: { kind: "zero_breakout", direction: "down" } });
  const bollinger = { ...asKind("bollinger"), band: "lower", direction: "down" } as const;
  expect(conditionOf({ ...bollinger, test: "cross" })).toMatchObject({ test: { kind: "cross", band: "lower", direction: "down" } });
  expect(conditionOf({ ...asKind("ichimoku"), test: "cross", direction: "down" })).toMatchObject({ test: { kind: "cross", direction: "down" } });
});

test("거래대금과 시가총액은 억 원으로 보이고 원으로 보낸다", () => {
  const traded = lineOf({ kind: "value_range", period: "D", m: 1, field: "traded_value", min: 10_000_000_000, max: 12_345_678_901 });
  expect(traded).toMatchObject({ min: "100", max: "123.45678901" });
  const cap = lineOf({ kind: "market_cap", min: 50_000_000, max: 3_000_000_000_000 });
  expect(cap).toMatchObject({ min: "0.5", max: "30000" });
  expect(conditionOf({ ...asKind("market_cap"), min: "0.00000001", max: "3,000" })).toEqual({ kind: "market_cap", min: 1, max: 300_000_000_000 });
  expect(conditionOf({ ...asKind("value_range"), min: "1.5", max: "" })).toMatchObject({ field: "traded_value", min: 150_000_000, max: null });
  expect(conditionOf({ ...asKind("value_range"), field: "close", min: "1.5", max: "" })).toMatchObject({ field: "close", min: 1.5 });
});

const everyKind: Screen = {
  id: "every",
  name: "열다섯 가지",
  markets: ["kosdaq"],
  exclude: ["spac"],
  conditions: [
    { kind: "market_cap", min: 123_456_789, max: null },
    { kind: "new_low", period: "M", m: 2, field: "traded_value", n: 36 },
    { kind: "value_range", period: "W", m: 1, field: "traded_value", min: 1.5, max: 98_765_432_101.25 },
    { kind: "change", period: "D", m: 3, back: 20, minPct: -12.75, maxPct: 0.001 },
    { kind: "near_extreme", period: "M", m: 1, extreme: "low", n: 120, withinPct: 7.5 },
    { kind: "surge", period: "D", m: 1, field: "traded_value", n: 60, times: 2.25 },
    { kind: "ma_position", period: "W", m: 4, field: "open", method: "ema", length: 33, side: "below" },
    { kind: "ma_alignment", period: "D", m: 1, method: "ema", lengths: [3, 8, 21, 55, 144], order: "bearish" },
    { kind: "ma_cross", period: "M", m: 2, method: "sma", fast: null, slow: 10, direction: "down" },
    { kind: "rsi", period: "D", m: 5, length: 21, test: { kind: "breakout", value: 72.5, direction: "down" } },
  ],
};
const everyIndicator: Screen = {
  id: "indicators",
  name: "보조지표",
  markets: ["kosdaq", "kospi"],
  exclude: [],
  conditions: [
    { kind: "macd", period: "W", m: 1, fast: 8, slow: 17, signal: 5, test: { kind: "vs_signal", side: "below" } },
    { kind: "stochastic", period: "D", m: 2, k: 14, d: 5, smooth: 5, test: { kind: "range", min: 80, max: null } },
    { kind: "bollinger", period: "M", m: 1, length: 30, k: 2.5, test: { kind: "cross", band: "lower", direction: "up" } },
    { kind: "ichimoku", period: "W", m: 3, conversion: 7, base: 22, spanB: 44, displacement: 22, test: { kind: "cross", direction: "down" } },
    { kind: "rsi", period: "M", m: 1, length: 14, test: { kind: "range", min: null, max: 30 } },
    { kind: "macd", period: "D", m: 1, fast: 12, slow: 26, signal: 9, test: { kind: "zero_breakout", direction: "up" } },
    { kind: "stochastic", period: "W", m: 1, k: 5, d: 3, smooth: 3, test: { kind: "cross", direction: "down" } },
    { kind: "bollinger", period: "D", m: 1, length: 20, k: 2, test: { kind: "outside", side: "above" } },
    { kind: "ichimoku", period: "D", m: 1, conversion: 9, base: 26, spanB: 52, displacement: 26, test: { kind: "cloud", side: "below" } },
    { kind: "new_high", period: "W", m: 1, field: "close", n: 520 },
  ],
};

test("저장한 조건식을 고치지 않고 다시 저장하면 줄 종류·순서·봉 주기·값과 필드 순서까지 같은 조건식이다", () => {
  for (const screen of [weekly, everyKind, everyIndicator]) {
    const check = checkDraft(draftOf(screen), screen.id, [screen]);
    expect(check).toEqual({ ok: true, screen });
    expect(check.ok && JSON.stringify(check.screen)).toBe(JSON.stringify(screen));
  }
});

test("15가지 종류와 줄마다 다른 봉 주기가 섞인 조건식도 이름만 바꿔 저장할 수 있다", () => {
  for (const screen of [everyKind, everyIndicator]) {
    const check = checkDraft({ ...draftOf(screen), name: "이름만 바꿈" }, screen.id, [weekly, everyKind, everyIndicator]);
    expect(check).toEqual({ ok: true, screen: { ...screen, name: "이름만 바꿈" } });
  }
  expect(new Set([...everyKind.conditions, ...everyIndicator.conditions].map((c) => c.kind)).size).toBe(15);
});

test("검사를 통과하면 서버가 돌려주는 필드 순서의 조건식이 된다", () => {
  let draft: ScreenDraft = { ...oneLine(), name: " 고가와 거래량 " };
  draft = toggleExclude(toggleExclude(draft, "trading_halted"), "etf");
  draft = toggleMarket(draft, "kosdaq");
  draft = addCondition(editCondition(draft, { ...firstLine(draft), period: "W" }));
  draft = editCondition(draft, { ...asKind("new_high", "W", "4"), key: draft.conditions[1]!.key, field: "volume" });
  const check = checkDraft(draft, "id-1", []);
  expect(check.ok && JSON.stringify(check.screen)).toBe(
    '{"id":"id-1","name":"고가와 거래량","markets":["kosdaq"],"exclude":["etf","trading_halted"],' +
      '"conditions":[{"kind":"new_high","period":"W","m":1,"field":"high","n":200},{"kind":"new_high","period":"W","m":4,"field":"volume","n":200}]}',
  );
});

test("시장 칩은 고른 시장만 남기고, 다시 누르면 풀리며, 아무것도 고르지 않으면 빈 목록이다", () => {
  const none = draftOf(null);
  expect(none.markets).toEqual([]);
  const both = toggleMarket(toggleMarket(none, "kosdaq"), "kospi");
  expect(both.markets).toEqual(["kospi", "kosdaq"]);
  expect(toggleMarket(both, "kospi").markets).toEqual(["kosdaq"]);
  expect(toggleMarket(toggleMarket(both, "kospi"), "kosdaq").markets).toEqual([]);
  const check = checkDraft(named(toggleMarket(none, "kospi")), "new", []);
  expect(check.ok && check.screen.markets).toEqual(["kospi"]);
});

test("조건식이 50개면 새로 만들 수 없지만 있던 것은 고칠 수 있다", () => {
  const full = many(50);
  expect(errorsOf({ ...draftOf(null), name: "하나 더" }, "new", full).list).toBe("조건식은 50개까지 저장할 수 있습니다. 하나를 지운 뒤 만드세요.");
  expect(checkDraft(draftOf(full[7]!), full[7]!.id, full).ok).toBe(true);
  expect(checkDraft({ ...draftOf(null), name: "마흔아홉 번째 뒤" }, "new", many(49)).ok).toBe(true);
});

test("조건 줄은 마지막 줄까지 뺄 수 있고, 빈 조건식에 다시 더할 수 있으며, 10줄 넘게 더할 수는 없다", () => {
  const one = oneLine();
  const none = removeCondition(one, firstLine(one).key);
  expect(none.conditions).toEqual([]);
  expect(conditionOf(firstLine(addCondition(none)))).toEqual({ kind: "new_high", period: "D", m: 1, field: "high", n: 200 });
  let draft = none;
  for (let i = 0; i < 12; i++) draft = addCondition(draft);
  expect(draft.conditions).toHaveLength(10);
  expect(new Set(draft.conditions.map((c) => c.key)).size).toBe(10);
  const second = draft.conditions[1]!.key;
  expect(removeCondition(draft, second).conditions.map((c) => c.key)).not.toContain(second);
});

test("제외 칩은 종류 넷과 상태 일곱으로 나뉘고, 한 번 더 누르면 풀린다", () => {
  expect(excludesIn("kind")).toEqual(["etf", "preferred", "reit", "spac"]);
  expect(excludesIn("status")).toEqual([
    "managed",
    "investment_caution_alert",
    "investment_warning",
    "investment_danger",
    "investment_caution",
    "short_term_overheated",
    "trading_halted",
  ]);
  const draft = toggleExclude(toggleExclude(draftOf(null), "spac"), "spac");
  expect(draft.exclude).toEqual([]);
});

test("저장할 목록에서 고친 조건식은 제자리에서 바뀌고 새 조건식은 끝에 붙는다", () => {
  const [a, b, c] = many(3) as [Screen, Screen, Screen];
  const renamed = { ...b, name: "새 이름" };
  expect(withScreen([a, b, c], renamed)).toEqual([a, renamed, c]);
  const fresh = { ...a, id: "s9" };
  expect(withScreen([a, b], fresh)).toEqual([a, b, fresh]);
});
