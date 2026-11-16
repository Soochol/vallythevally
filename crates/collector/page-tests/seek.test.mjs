import assert from "node:assert/strict";
import { test } from "node:test";

import { entryIndexAt, lastRowAtOrBefore } from "../page/seek.js";

const rows = Int32Array.from([100, 200, 200, 300]);

test("첫 행보다 이른 시각에는 행이 없다", () => {
  assert.equal(lastRowAtOrBefore(rows, 99), -1);
});

test("행 시각과 같은 시각은 그 행이다", () => {
  assert.equal(lastRowAtOrBefore(rows, 100), 0);
  assert.equal(lastRowAtOrBefore(rows, 300), 3);
});

test("같은 시각의 행이 여럿이면 받은 순서의 마지막이다", () => {
  assert.equal(lastRowAtOrBefore(rows, 200), 2);
});

test("두 행 사이의 시각은 앞 행이다", () => {
  assert.equal(lastRowAtOrBefore(rows, 250), 2);
  assert.equal(lastRowAtOrBefore(rows, 150), 0);
});

test("마지막 행 뒤의 시각은 마지막 행이다", () => {
  assert.equal(lastRowAtOrBefore(rows, 10_000_000), 3);
});

test("이월 행만 있는 흐름은 구간 안 모든 시각에서 그 행이다", () => {
  const carried = Int32Array.from([36_000_000 - 5000]);
  assert.equal(lastRowAtOrBefore(carried, 36_000_000), 0);
  assert.equal(lastRowAtOrBefore(carried, 36_000_000 + 299_999), 0);
});

test("행이 0개인 흐름은 언제나 행이 없다", () => {
  assert.equal(lastRowAtOrBefore(new Int32Array(0), 0), -1);
  assert.equal(lastRowAtOrBefore(new Int32Array(0), 50_000_000), -1);
});

test("시각이 속한 구간 파일을 찾는다", () => {
  const starts = [600, 605, 610];
  const minute = 60_000;
  assert.equal(entryIndexAt(starts, 600 * minute - 1), -1);
  assert.equal(entryIndexAt(starts, 600 * minute), 0);
  assert.equal(entryIndexAt(starts, 605 * minute - 1), 0);
  assert.equal(entryIndexAt(starts, 605 * minute), 1);
  assert.equal(entryIndexAt(starts, 615 * minute - 1), 2);
  assert.equal(entryIndexAt(starts, 615 * minute), -1);
});

test("빠진 구간의 시각은 파일이 없다", () => {
  const minute = 60_000;
  assert.equal(entryIndexAt([600, 610], 607 * minute), -1);
  assert.equal(entryIndexAt([], 0), -1);
});
