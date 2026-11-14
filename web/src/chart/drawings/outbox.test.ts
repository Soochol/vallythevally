import { describe, expect, test } from "vitest";
import { RETRY_DELAYS_MS } from "../../persist/saver";
import { EMPTY_OUTBOX, enqueue, flushable, isFailed, latestWant, nextToSend, parseDrawingBody, parseRecord, retryFailed, settle, start, type Intent, type Outbox, type Want, wantOf } from "./outbox";
import type { DrawingBody } from "./types";

const body = (id: string, price: number, revision = 0): DrawingBody => ({
  id, symbol: "005930", tool: "trendline", points: [{ t: 1, price }, { t: 2, price: price + 10 }], text: null, style: { v: 1 },
  locked: false, hidden: false, periods: ["D", "60m"], z: 1, group: null, scope: { kind: "cell", layoutId: "L1", windowId: "cell-2" }, revision,
});
const put = (b: DrawingBody): Want => ({ kind: "put", body: b, reserved: true });
const del: Want = { kind: "delete" };
const intent = (id: string, order: number, want: Want = put(body(id, order, order))): Intent => ({ v: 2, id, symbol: "005930", uuid: `${id}-${order}`, order, want, lastRevision: order });
function send(o: Outbox, id: string) { const started = start(o, id); if (!started) throw new Error(`nothing to send for ${id}`); return started; }
function ok(o: Outbox, id: string) { const result = settle(o, id, { kind: "ok" }, 0); if (!result) throw new Error(`nothing in flight for ${id}`); return result; }

describe("immutable admitted intent delivery", () => {
  test("one flight per id coalesces the next admitted intentions", () => {
    const first = intent("a", 1); const last = intent("a", 3);
    let o = send(enqueue(EMPTY_OUTBOX, first), "a").outbox;
    expect(start(o, "a")).toBeNull();
    o = enqueue(enqueue(o, intent("a", 2)), last);
    expect(nextToSend(o, 100)).toEqual([]);
    const result = ok(o, "a");
    expect(result.settled).toEqual({ kind: "acked", sent: first });
    expect(send(result.outbox, "a").send).toBe(last);
  });

  test("DELETE follows a flying PUT while another id can send independently", () => {
    let o = send(enqueue(EMPTY_OUTBOX, intent("a", 1)), "a").outbox;
    o = enqueue(enqueue(o, intent("a", 2, del)), intent("b", 1));
    expect(latestWant(o.lanes.get("a")!)).toEqual(del);
    expect(nextToSend(o, 0)).toEqual(["b"]);
    expect(send(ok(o, "a").outbox, "a").send.want).toEqual(del);
  });

  test("network retries preserve the exact intent and reserved revision", () => {
    const original = intent("a", 100);
    let o = send(enqueue(EMPTY_OUTBOX, original), "a").outbox;
    let now = 0;
    for (const delay of RETRY_DELAYS_MS) {
      const result = settle(o, "a", { kind: "networkError" }, now);
      expect(result?.settled).toEqual({ kind: "retrying", at: now + delay });
      o = result?.outbox ?? o;
      expect(nextToSend(o, now + delay - 1)).toEqual([]);
      now += delay;
      expect(nextToSend(o, now)).toEqual(["a"]);
      const started = send(o, "a");
      expect(started.send).toBe(original);
      o = started.outbox;
    }
    o = settle(o, "a", { kind: "networkError" }, now)?.outbox ?? o;
    expect(isFailed(o.lanes.get("a")!)).toBe(true);
    expect(nextToSend(o, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(send(retryFailed(o), "a").send).toBe(original);
  });

  test("a network failure uses the newer admitted intent without changing its identity", () => {
    const next = intent("a", 2, del);
    const flying = enqueue(send(enqueue(EMPTY_OUTBOX, intent("a", 1)), "a").outbox, next);
    const result = settle(flying, "a", { kind: "networkError" }, 0);
    expect(send(result?.outbox ?? EMPTY_OUTBOX, "a").send).toBe(next);
  });

  test("stale and rejected flights release the next intent", () => {
    const next = intent("a", 2);
    const flying = enqueue(send(enqueue(EMPTY_OUTBOX, intent("a", 1)), "a").outbox, next);
    for (const outcome of [{ kind: "stale" }, { kind: "clientError", tooLarge: true }] as const) {
      const result = settle(flying, "a", outcome, 0);
      expect(send(result?.outbox ?? EMPTY_OUTBOX, "a").send).toBe(next);
    }
    expect(settle(EMPTY_OUTBOX, "a", { kind: "ok" }, 0)).toBeNull();
  });

  test("pagehide flush selects waiting admitted intentions only", () => {
    const o = enqueue(send(enqueue(EMPTY_OUTBOX, intent("a", 1)), "a").outbox, intent("b", 1, del));
    expect(flushable(o)).toEqual(["b"]);
  });
});

describe("legacy journal boundary", () => {
  test("v1 parse retains a previously reserved PUT revision", () => {
    const record = { v: 1, id: "a", symbol: "005930", want: put(body("a", 1, 42)), lastRevision: 42 };
    expect(parseRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  test("invalid v1 records are rejected", () => {
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

  test("body timestamps remain safe integers", () => {
    expect(parseDrawingBody(body("a", 1))).toEqual(body("a", 1));
    expect(parseDrawingBody({ ...body("a", 1), points: [{ t: 1.5, price: 1 }, { t: 2, price: 1 }] })).toBeNull();
  });
});

test("operations select PUT or DELETE", () => {
  expect(wantOf({ kind: "create", after: body("a", 1) })).toEqual({ kind: "put", body: body("a", 1) });
  expect(wantOf({ kind: "delete", before: body("a", 1) })).toEqual(del);
});
