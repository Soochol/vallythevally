import { expect, test } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "../../chart/settings";
import { addRows, BELOW_GROUP, PRICE_GROUP, stepRow } from "./model";

const NONE = { indicators: [] };

test("입력이 비면 모든 지표 종류를 켜고 끄는 줄로 보이고 가격 위 지표가 먼저 온다", () => {
  const rows = addRows(DEFAULT_CHART_SETTINGS, "");
  expect(rows.every((row) => row.kind === "switch")).toBe(true);
  expect(rows[0]).toMatchObject({ group: PRICE_GROUP, candidate: { kind: "ma" }, count: 0 });
  expect(rows.find((row) => row.candidate.kind === "volume")).toMatchObject({ group: BELOW_GROUP, count: 1 });
});

test("이름만 적으면 그 종류의 스위치 줄만 남는다", () => {
  expect(addRows(NONE, "rsi").map((row) => [row.kind, row.candidate.kind])).toEqual([["switch", "rsi"]]);
});

test("숫자까지 적으면 그 설정값으로 더하는 후보 줄이 된다", () => {
  const rows = addRows(NONE, "이평 60");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "candidate", candidate: { kind: "ma", label: "이동평균 단순 60" } });
});

test("설정값이 없는 종류는 숫자를 적어도 스위치 줄로 남는다", () => {
  expect(addRows(NONE, "매출 3").map((row) => row.kind)).toEqual(["switch"]);
});

test("줄 이동은 처음과 끝에서 돌아가고 줄이 없으면 고르지 않는다", () => {
  expect(stepRow(0, -1, 3)).toBe(2);
  expect(stepRow(2, 1, 3)).toBe(0);
  expect(stepRow(-1, 1, 3)).toBe(0);
  expect(stepRow(0, 1, 0)).toBe(-1);
});
