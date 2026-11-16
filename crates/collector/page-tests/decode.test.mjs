import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DecodeError, decodeSpan, openSpan } from "../page/decode.js";

const FIXTURES = new URL("../../hoga-format/tests/fixtures/", import.meta.url);
const reference = JSON.parse(readFileSync(new URL("span-v1.json", FIXTURES), "utf8"));
const referenceBytes = readFileSync(new URL("span-v1.hoga", FIXTURES));

const copyOf = (bytes) => Uint8Array.from(bytes).buffer;

test("기준 파일을 풀면 기준 JSON과 같은 값이 나온다", () => {
  const buffer = copyOf(referenceBytes);
  const span = openSpan(decodeSpan(buffer), buffer);
  assert.equal(span.date, reference.date);
  assert.equal(span.startMinute, reference.start_minute);
  assert.equal(span.lengthMinutes, reference.length_minutes);
  assert.equal(span.symbol, reference.symbol);
  assert.deepEqual(Object.keys(span.streams).sort(), reference.streams.map((stream) => stream.kind).sort());
  for (const expected of reference.streams) {
    const stream = span.streams[expected.kind];
    assert.deepEqual(Object.keys(stream.columns), expected.columns.map((column) => column.name), expected.kind);
    for (const column of expected.columns) {
      assert.deepEqual(Array.from(stream.columns[column.name]), column.values, `${expected.kind}.${column.name}`);
    }
  }
});

test("i32 경계 값과 감싸는 차분이 그대로 돌아온다", () => {
  const buffer = copyOf(referenceBytes);
  const span = openSpan(decodeSpan(buffer), buffer);
  const values = Array.from(span.streams.book.columns.ask_total);
  assert.ok(values.some((value) => value < 0 || value > 2 ** 30));
});

test("magic이 다르면 거절한다", () => {
  const bytes = Uint8Array.from(referenceBytes);
  bytes[0] = 0x58;
  assert.throws(() => decodeSpan(bytes.buffer), (error) => error instanceof DecodeError && /magic/.test(error.message));
});

test("버전 2는 거절한다", () => {
  const bytes = Uint8Array.from(referenceBytes);
  new DataView(bytes.buffer).setUint16(4, 2, true);
  assert.throws(() => decodeSpan(bytes.buffer), (error) => error instanceof DecodeError && /버전/.test(error.message));
});

test("잘린 파일은 어디서 잘려도 거절한다", () => {
  for (const length of [0, 3, 4, 10, 14, 20, 40, 100, referenceBytes.length - 1]) {
    const cut = Uint8Array.from(referenceBytes.subarray(0, length));
    assert.throws(() => decodeSpan(cut.buffer), DecodeError, `길이 ${length}`);
  }
});

test("본문 뒤에 남는 바이트가 있으면 거절한다", () => {
  const longer = new Uint8Array(referenceBytes.length + 4);
  longer.set(referenceBytes);
  assert.throws(() => decodeSpan(longer.buffer), (error) => error instanceof DecodeError && /남는/.test(error.message));
});

test("알 수 없는 흐름 종류는 거절한다", () => {
  const bytes = Uint8Array.from(referenceBytes);
  const symbolLength = bytes[14];
  bytes[15 + symbolLength + 1] = 9;
  assert.throws(() => decodeSpan(bytes.buffer), (error) => error instanceof DecodeError && /종류/.test(error.message));
});
