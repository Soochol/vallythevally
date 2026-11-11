import { expect, test } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import {
  addCondition,
  type ConditionErrors,
  checkCondition,
  checkDraft,
  draftOf,
  editCondition,
  excludesIn,
  NOT_EDITABLE_HERE,
  removeCondition,
  type ScreenDraft,
  toggleExclude,
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
const withCounts = (n: string, m: string, period: ScreenDraft["period"] = "D"): ScreenDraft => {
  const draft = { ...draftOf(null), name: "시험", period };
  return editCondition(draft, draft.conditions[0]!.key, { n, m });
};
const rowErrors = (n: string, m: string, period: ScreenDraft["period"] = "D"): ConditionErrors => {
  const draft = withCounts(n, m, period);
  expect(checkDraft(draft, "new", []).ok).toBe(false);
  const row = checkCondition(draft.conditions[0]!, period);
  if (row.ok) throw new Error("조건 검사를 통과하면 안 된다");
  return row.errors;
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

test("M이 N보다 크면 M 칸에 봉 주기 단위로 이유를 단다", () => {
  expect(rowErrors("200", "201")).toEqual({ n: null, m: "신고가 기간 200일보다 길 수 없습니다" });
  expect(rowErrors("52", "53", "W")).toEqual({ n: null, m: "신고가 기간 52주보다 길 수 없습니다" });
  expect(rowErrors("12", "13", "M")).toEqual({ n: null, m: "신고가 기간 12개월보다 길 수 없습니다" });
  expect(checkDraft(withCounts("200", "200"), "new", []).ok).toBe(true);
});

test("N과 M은 1 이상의 정수여야 하고, N은 u32 끝까지 받는다", () => {
  for (const bad of ["", "0", "1.5", "-3", "abc", "2e3", "1,00"]) {
    expect(rowErrors(bad, "1").n).toBe("1 이상의 정수를 넣으세요");
    expect(rowErrors("200", bad).m).toBe("1 이상의 정수를 넣으세요");
  }
  expect(rowErrors("4294967296", "1")).toEqual({ n: "4,294,967,295 이하로 넣으세요", m: null });
  const longest = checkDraft(withCounts(" 4294967295 ", "1,000"), "new", []);
  expect(longest.ok && longest.screen.conditions).toEqual([{ kind: "new_high", period: "D", m: 1000, field: "high", n: 4_294_967_295 }]);
});

test("검사를 통과하면 서버가 돌려주는 필드 순서의 조건식이 된다", () => {
  let draft: ScreenDraft = { ...draftOf(null), name: " 고가와 거래량 ", period: "W" };
  draft = toggleExclude(toggleExclude(draft, "trading_halted"), "etf");
  draft = addCondition(draft);
  draft = editCondition(draft, draft.conditions[1]!.key, { field: "volume", m: "4" });
  const check = checkDraft(draft, "id-1", []);
  expect(check.ok && JSON.stringify(check.screen)).toBe(
    '{"id":"id-1","name":"고가와 거래량","markets":[],"exclude":["etf","trading_halted"],' +
      '"conditions":[{"kind":"new_high","period":"W","m":1,"field":"high","n":200},{"kind":"new_high","period":"W","m":4,"field":"volume","n":200}]}',
  );
});

test("대화상자에서 고른 봉 주기 하나를 모든 줄의 봉 주기로 쓰고, 저장된 시장은 그대로 둔다", () => {
  const kosdaq: Screen = { ...weekly, markets: ["kosdaq"] };
  const draft = draftOf(kosdaq);
  expect(draft.period).toBe("W");
  const check = checkDraft({ ...draft, period: "M" }, kosdaq.id, [kosdaq]);
  expect(check.ok && check.screen.markets).toEqual(["kosdaq"]);
  expect(check.ok && check.screen.conditions.map((c) => c.kind !== "market_cap" && c.period)).toEqual(["M", "M"]);
});

test("이 화면이 그대로 나타내지 못하는 조건식은 이름만 바꿔도 이유를 달고 저장을 막지만, 다른 조건식과 새 조건식은 막지 않는다", () => {
  const withMarketCap: Screen = { ...weekly, id: "cap", conditions: [weekly.conditions[0]!, { kind: "market_cap", min: 300_000_000_000, max: null }] };
  const mixedPeriods: Screen = { ...weekly, id: "mixed", conditions: [weekly.conditions[0]!, { kind: "new_high", period: "D", m: 1, field: "close", n: 20 }] };
  const saved = [weekly, withMarketCap, mixedPeriods];
  for (const screen of [withMarketCap, mixedPeriods]) {
    expect(checkDraft(draftOf(screen), screen.id, saved)).toEqual({ ok: false, errors: { name: null, list: NOT_EDITABLE_HERE } });
    expect(checkDraft({ ...draftOf(screen), name: "이름만 바꿈" }, screen.id, saved)).toEqual({ ok: false, errors: { name: null, list: NOT_EDITABLE_HERE } });
  }
  expect(checkDraft(draftOf(weekly), weekly.id, saved)).toEqual({ ok: true, screen: weekly });
  expect(checkDraft({ ...draftOf(null), name: "새 조건식" }, "new", saved).ok).toBe(true);
});

test("거래대금 신고가 줄은 값을 거래대금으로 읽고 그대로 다시 저장한다", () => {
  const traded: Screen = { ...weekly, conditions: [{ kind: "new_high", period: "W", m: 1, field: "traded_value", n: 52 }] };
  expect(draftOf(traded).conditions.map((c) => c.field)).toEqual(["traded_value"]);
  expect(checkDraft(draftOf(traded), traded.id, [traded])).toEqual({ ok: true, screen: traded });
});

test("저장한 조건식을 고치지 않고 다시 저장하면 같은 조건식이다", () => {
  expect(checkDraft(draftOf(weekly), weekly.id, [weekly])).toEqual({ ok: true, screen: weekly });
});

test("조건식이 50개면 새로 만들 수 없지만 있던 것은 고칠 수 있다", () => {
  const full = many(50);
  expect(errorsOf({ ...draftOf(null), name: "하나 더" }, "new", full).list).toBe("조건식은 50개까지 저장할 수 있습니다. 하나를 지운 뒤 만드세요.");
  expect(checkDraft(draftOf(full[7]!), full[7]!.id, full).ok).toBe(true);
  expect(checkDraft({ ...draftOf(null), name: "마흔아홉 번째 뒤" }, "new", many(49)).ok).toBe(true);
});

test("조건 줄은 1줄 밑으로 빼거나 10줄 넘게 더할 수 없다", () => {
  const one = draftOf(null);
  expect(removeCondition(one, one.conditions[0]!.key).conditions).toHaveLength(1);
  let draft = one;
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
