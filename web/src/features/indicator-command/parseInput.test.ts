import { expect, test } from "vitest";
import { parseIndicatorInput } from "./parseInput";

const first = (input: string) => parseIndicatorInput(input)[0];

test("지표 이름·영문 약어와 숫자로 후보 설정을 만든다", () => {
  expect(first("이평 20")).toMatchObject({ kind: "ma", form: { text: { method: "sma", period: "20" } }, errors: [] });
  expect(first("bb 20 2")).toMatchObject({ kind: "bollinger", form: { text: { period: "20", k: "2" } }, errors: [] });
  expect(first("rsi")).toMatchObject({ kind: "rsi", form: { text: { period: "14", signal: "9" }, enabled: { signal: false } }, errors: [] });
  expect(first("EMA60")).toMatchObject({ kind: "ma", form: { text: { method: "ema", period: "60" } }, errors: [] });
  expect(first("rsi 20 5")).toMatchObject({ kind: "rsi", form: { text: { period: "20", signal: "5" }, enabled: { signal: true } } });
});

test("한글 이름·초성·재무 지표를 찾고 숫자 종목 코드는 지표로 읽지 않는다", () => {
  expect(first("ㅇㅍ")?.kind).toBe("ma");
  expect(first("ㅂㄹㅈ")?.kind).toBe("bollinger");
  expect(first("매출액")?.kind).toBe("revenue");
  expect(first("영업이익")?.kind).toBe("operating_income");
  expect(first("roe")?.kind).toBe("owner_roe");
  expect(first("부채비율")?.kind).toBe("debt_ratio");
  expect(parseIndicatorInput("005930")).toEqual([]);
  expect(parseIndicatorInput("없는 지표")).toEqual([]);
});

test.each(["이평 0", "ma -1", "ma 2.5", "ma 65536", "ma nope", "bb 20 -2", "bb 20 2 5", "매출액 20"])("숫자가 틀린 입력 %s를 추가 가능한 후보로 만들지 않는다", (input) => {
  expect(first(input)?.errors.length).toBeGreaterThan(0);
});

test("설정 양식과 같은 방식으로 작은 소수와 지수 표기를 읽는다", () => {
  expect(first("bb 20 .5")).toMatchObject({ form: { text: { k: ".5" } }, errors: [] });
  expect(first("bb 20 2e0")).toMatchObject({ form: { text: { k: "2e0" } }, errors: [] });
  expect(first("bb 20 Infinity")?.errors.length).toBeGreaterThan(0);
});
