import { describe, expect, test } from "vitest";
import { RETRY_DELAYS_MS } from "../../persist/saver";
import {
  EMPTY_OUTBOX,
  enqueue,
  flushable,
  isFailed,
  nextToSend,
  type Outbox,
  parseDrawingBody,
  parseRecord,
  pendingWants,
  recordChanges,
  restore,
  retryFailed,
  settle,
  start,
  type Want,
  wantOf,
} from "./outbox";
import type { DrawingBody } from "./types";

const body = (id: string, price: number, revision = 0): DrawingBody => ({
  id,
  symbol: "005930",
  tool: "trendline",
  points: [
    { t: 1_762_300_800, price },
    { t: 1_762_387_200, price: price + 10 },
  ],
  text: null,
  style: { v: 1 },
  locked: false,
  hidden: false,
  periods: ["D", "60m"],
  z: 1,
  group: null,
  scope: { kind: "cell", layoutId: "L1", slot: 2 },
  revision,
});

const put = (b: DrawingBody): Want => ({ kind: "put", body: b });
const del: Want = { kind: "delete" };
const clock = (ms: number) => () => ms;

function send(o: Outbox, id: string, now: number) {
  const r = start(o, id, clock(now));
  if (r === null) throw new Error(`nothing to start for ${id}`);
  return r;
}

function ok(o: Outbox, id: string, now = 0) {
  const r = settle(o, id, { kind: "ok" }, now);
  if (r === null) throw new Error(`nothing in flight for ${id}`);
  return r;
}

describe("드로잉 id마다 보내는 중인 요청은 하나", () => {
  test("보내는 중에는 다시 시작하지 않고, 그사이 쓰기는 마지막 하나로 합친다", () => {
    let o = enqueue(EMPTY_OUTBOX, { id: "a", symbol: "005930", want: put(body("a", 100)) });
    const first = send(o, "a", 1000);
    o = first.outbox;
    expect(start(o, "a", clock(1001))).toBeNull();
    expect(nextToSend(o, 1001)).toEqual([]);
    o = enqueue(o, { id: "a", symbol: "005930", want: put(body("a", 110)) });
    o = enqueue(o, { id: "a", symbol: "005930", want: put(body("a", 120)) });
    const acked = ok(o, "a");
    expect(acked.settled).toEqual({ kind: "acked", sent: first.send.want });
    expect(nextToSend(acked.outbox, 0)).toEqual(["a"]);
    const second = send(acked.outbox, "a", 1002);
    expect(second.send.want).toEqual(put(body("a", 120, 1002)));
    expect(ok(second.outbox, "a").outbox.lanes.size).toBe(0);
  });

  test("PUT 뒤의 DELETE는 PUT이 끝난 뒤에 나간다", () => {
    let o = send(enqueue(EMPTY_OUTBOX, { id: "a", symbol: "005930", want: put(body("a", 1)) }), "a", 10).outbox;
    o = enqueue(o, { id: "a", symbol: "005930", want: del });
    expect(pendingWants(o).get("a")).toEqual(del);
    o = ok(o, "a").outbox;
    expect(send(o, "a", 11).send).toEqual({ id: "a", symbol: "005930", want: del });
  });

  test("다른 id는 따로 나란히 나간다", () => {
    let o = enqueue(EMPTY_OUTBOX, { id: "a", symbol: "005930", want: put(body("a", 1)) });
    o = enqueue(o, { id: "b", symbol: "005930", want: put(body("b", 1)) });
    o = send(o, "a", 1).outbox;
    expect(nextToSend(o, 1)).toEqual(["b"]);
  });
});

describe("revision = max(지금, 마지막 + 1)", () => {
  test("시계가 멈춰도 늘어난다", () => {
    let o = enqueue(EMPTY_OUTBOX, { id: "a", symbol: "005930", want: put(body("a", 1)) });
    let r = send(o, "a", 500);
    expect(r.send.want).toEqual(put(body("a", 1, 500)));
    o = enqueue(ok(r.outbox, "a").outbox, { id: "a", symbol: "005930", want: put(body("a", 2)) });
    r = send(o, "a", 500);
    expect(r.send.want).toEqual(put(body("a", 2, 501)));
  });

  test("본문이 가진 서버 revision보다 크다", () => {
    const o = enqueue(EMPTY_OUTBOX, { id: "a", symbol: "005930", want: put(body("a", 1, 9_000)) });
    expect(send(o, "a", 10).send.want).toEqual(put(body("a", 1, 9_001)));
  });

  test("DELETE에는 revision이 없다", () => {
    const o = enqueue(EMPTY_OUTBOX, { id: "a", symbol: "005930", want: del });
    expect(send(o, "a", 10).send.want).toEqual(del);
  });
});

describe("응답", () => {
  const flying = (next: Want | null) => {
    let o = send(enqueue(EMPTY_OUTBOX, { id: "a", symbol: "005930", want: put(body("a", 1)) }), "a", 100).outbox;
    if (next !== null) o = enqueue(o, { id: "a", symbol: "005930", want: next });
    return o;
  };

  test("409 stale은 그 본문을 버리고 기다리던 것을 보낸다", () => {
    const dropped = settle(flying(null), "a", { kind: "stale" }, 0);
    expect(dropped?.settled).toEqual({ kind: "stale" });
    expect(dropped?.outbox.lanes.size).toBe(0);
    const r = settle(flying(put(body("a", 2))), "a", { kind: "stale" }, 0);
    expect(r?.outbox.lanes.get("a")).toMatchObject({ state: "waiting", want: put(body("a", 2)) });
  });

  test("400·413은 거절이다. 기다리는 다른 쓰기가 있으면 그것은 보낸다", () => {
    expect(settle(flying(null), "a", { kind: "clientError", tooLarge: true }, 0)?.settled).toEqual({ kind: "rejected", tooLarge: true });
    expect(settle(flying(null), "a", { kind: "clientError", tooLarge: false }, 0)?.outbox.lanes.size).toBe(0);
    expect(settle(flying(del), "a", { kind: "clientError", tooLarge: false }, 0)?.outbox.lanes.get("a")).toMatchObject({ want: del });
  });

  test("네트워크 오류는 RETRY_DELAYS_MS로 다시 보내고, 다 쓰면 실패로 남는다", () => {
    let o = flying(null);
    let now = 0;
    for (const delay of RETRY_DELAYS_MS) {
      const r = settle(o, "a", { kind: "networkError" }, now);
      expect(r?.settled).toEqual({ kind: "retrying", at: now + delay });
      o = r?.outbox ?? o;
      expect(nextToSend(o, now + delay - 1)).toEqual([]);
      now += delay;
      expect(nextToSend(o, now)).toEqual(["a"]);
      o = send(o, "a", now).outbox;
    }
    const last = settle(o, "a", { kind: "networkError" }, now);
    expect(last?.settled).toEqual({ kind: "failed" });
    o = last?.outbox ?? o;
    const lane = o.lanes.get("a");
    expect(lane !== undefined && isFailed(lane)).toBe(true);
    expect(nextToSend(o, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(nextToSend(retryFailed(o), now)).toEqual(["a"]);
  });

  test("네트워크 오류 때 기다리던 새 쓰기가 있으면 그것을 다시 보낸다", () => {
    const r = settle(flying(put(body("a", 9))), "a", { kind: "networkError" }, 0);
    expect(r?.outbox.lanes.get("a")).toMatchObject({ state: "waiting", want: put(body("a", 9)), failures: 1 });
  });

  test("새 쓰기는 실패 횟수를 지우고 바로 보낸다", () => {
    let o = settle(flying(null), "a", { kind: "networkError" }, 0)?.outbox ?? EMPTY_OUTBOX;
    o = enqueue(o, { id: "a", symbol: "005930", want: put(body("a", 3)) });
    expect(nextToSend(o, 0)).toEqual(["a"]);
  });

  test("보내는 중이 아닌 줄에 온 응답은 무시한다", () => {
    expect(settle(EMPTY_OUTBOX, "a", { kind: "ok" }, 0)).toBeNull();
  });
});

test("탭을 닫을 때는 보내는 중이 아닌 줄만 keepalive로 보낸다", () => {
  let o = enqueue(EMPTY_OUTBOX, { id: "a", symbol: "005930", want: put(body("a", 1)) });
  o = enqueue(o, { id: "b", symbol: "005930", want: del });
  o = send(o, "a", 1).outbox;
  expect(flushable(o)).toEqual(["b"]);
});

describe("localStorage 줄 기록", () => {
  test("바뀐 줄만 쓰고, 끝난 줄은 지운다", () => {
    const a = enqueue(EMPTY_OUTBOX, { id: "a", symbol: "005930", want: put(body("a", 1)) });
    const ab = enqueue(a, { id: "b", symbol: "005930", want: del });
    expect(recordChanges(a, ab)).toEqual({ write: [{ v: 1, id: "b", symbol: "005930", want: del, lastRevision: 0 }], remove: [] });
    const sent = send(ab, "a", 7).outbox;
    expect(recordChanges(ab, sent).write.map((r) => [r.id, r.lastRevision])).toEqual([["a", 7]]);
    expect(recordChanges(sent, ok(sent, "a").outbox)).toEqual({ write: [], remove: ["a"] });
  });

  test("JSON으로 갔다 와도 같다", () => {
    const o = send(enqueue(EMPTY_OUTBOX, { id: "a", symbol: "005930", want: put(body("a", 1)) }), "a", 42).outbox;
    const [record] = recordChanges(EMPTY_OUTBOX, o).write;
    const parsed = parseRecord(JSON.parse(JSON.stringify(record)));
    expect(parsed).toEqual(record);
    const restored = restore(parsed === null ? [] : [parsed]);
    expect(restored.lanes.get("a")).toMatchObject({ state: "waiting", want: put(body("a", 1, 42)) });
    expect(send(restored, "a", 1).send.want).toEqual(put(body("a", 1, 43)));
  });

  test("모양이 틀린 기록은 버린다", () => {
    const good = { v: 1, id: "a", symbol: "005930", want: put(body("a", 1)), lastRevision: 0 };
    expect(parseRecord(good)).not.toBeNull();
    expect(parseRecord({ ...good, v: 2 })).toBeNull();
    expect(parseRecord({ ...good, id: "b" })).toBeNull();
    expect(parseRecord({ ...good, want: { kind: "put", body: { ...body("a", 1), tool: "laser" } } })).toBeNull();
    expect(parseRecord({ ...good, want: { kind: "put", body: { ...body("a", 1), points: [{ t: 1, price: 2 }] } } })).toBeNull();
    expect(parseRecord({ ...good, want: { kind: "put", body: { ...body("a", 1), periods: [] } } })).toBeNull();
    expect(parseRecord({ ...good, want: { kind: "put", body: { ...body("a", 1), scope: { kind: "cell", layoutId: "L" } } } })).toBeNull();
    expect(parseRecord("nope")).toBeNull();
  });

  test("본문 검사는 t가 정수인지 본다", () => {
    const b = body("a", 1);
    expect(parseDrawingBody(b)).toEqual(b);
    expect(parseDrawingBody({ ...b, points: [{ t: 1.5, price: 1 }, { t: 2, price: 1 }] })).toBeNull();
  });
});

test("wantOf: 만들기·바꾸기는 PUT, 지우기는 DELETE", () => {
  expect(wantOf({ kind: "create", after: body("a", 1) })).toEqual(put(body("a", 1)));
  expect(wantOf({ kind: "delete", before: body("a", 1) })).toEqual(del);
});
