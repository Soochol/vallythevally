import assert from "node:assert/strict";
import { test } from "node:test";

import { STALE, latestOnly } from "../page/latest.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

test("늦게 도착한 앞 요청의 응답은 버린다", async () => {
  const pending = { first: deferred(), second: deferred() };
  const load = latestOnly((name) => pending[name].promise);
  const first = load("first");
  const second = load("second");
  pending.second.resolve("둘째");
  pending.first.resolve("첫째");
  assert.equal(await second, "둘째");
  assert.equal(await first, STALE);
});

test("앞 요청이 먼저 도착해도 마지막 요청이 아니면 버린다", async () => {
  const pending = { first: deferred(), second: deferred() };
  const load = latestOnly((name) => pending[name].promise);
  const first = load("first");
  const second = load("second");
  pending.first.resolve("첫째");
  assert.equal(await first, STALE);
  pending.second.resolve("둘째");
  assert.equal(await second, "둘째");
});

test("늦게 실패한 앞 요청의 오류는 버린다", async () => {
  const pending = { first: deferred(), second: deferred() };
  const load = latestOnly((name) => pending[name].promise);
  const first = load("first");
  const second = load("second");
  pending.second.resolve("둘째");
  pending.first.reject(new Error("HTTP 500"));
  assert.equal(await second, "둘째");
  assert.equal(await first, STALE);
});

test("마지막 요청의 오류는 그대로 던진다", async () => {
  const load = latestOnly(() => Promise.reject(new Error("HTTP 500")));
  await assert.rejects(load("only"), /HTTP 500/);
});

test("앞 요청이 끝난 뒤의 새 요청은 정상으로 돌려준다", async () => {
  const load = latestOnly(async (name) => name);
  assert.equal(await load("a"), "a");
  assert.equal(await load("b"), "b");
});
