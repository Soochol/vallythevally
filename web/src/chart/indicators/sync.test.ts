import { expect, test, vi } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import { createHub, type WorkerLike } from "./client";
import { applyToPoints, DrawQueue, pointAtTime } from "./drawQueue";
import type { FromWorker, ToWorker } from "./protocol";
import { syncOp } from "./sync";

const b = (t: number, c = 10): Bar => ({ t, o: 10, h: 10, l: 10, c, v: 1 });

test("커밋한 확정 봉보다 늦은 꼬리 변경은 preview·confirm, 나머지는 다시 만든다", () => {
  const a = b(60);
  const cur = b(120);
  const prev = [a, cur];
  const moved = b(120, 11);
  expect(syncOp(prev, [a, moved], moved, "live", 60)).toBe("preview");
  expect(syncOp(prev, [a, moved], moved, "confirmed", 60)).toBe("confirm");
  const next = b(180);
  expect(syncOp(prev, [a, cur, next], next, "live", 60)).toBe("preview");
  const sameAsConfirmed = b(60, 9);
  expect(syncOp([a], [sameAsConfirmed], sameAsConfirmed, "live", 60)).toBe("create");
  expect(syncOp([a], [sameAsConfirmed], sameAsConfirmed, "confirmed", 60)).toBe("create");
  const replaced = b(180);
  expect(syncOp(prev, [a, replaced], replaced, "live", 60)).toBe("create");
  expect(syncOp(prev, [b(0), a, cur], cur, "live", 60)).toBe("create");
  expect(syncOp([], [cur], cur, "live", null)).toBe("preview");
});

test("그리기 큐는 시리즈마다 점 시각별로 하나씩 남기고, set은 앞의 update를 지운다", () => {
  const q = new DrawQueue<string>();
  q.push("s", { op: "update", point: { t: 60, v: 1 } });
  q.push("s", { op: "update", point: { t: 60, v: 2 } });
  q.push("s", { op: "update", point: { t: 120, v: 3 } });
  q.push("s", { op: "none" });
  expect(q.drain()).toEqual([["s", { set: null, updates: [{ t: 60, v: 2 }, { t: 120, v: 3 }] }]]);
  q.push("s", { op: "update", point: { t: 60, v: 1 } });
  q.push("s", { op: "set", points: [{ t: 0, v: 0 }] });
  q.push("s", { op: "update", point: { t: 60, v: 4 } });
  expect(q.drain()).toEqual([["s", { set: [{ t: 0, v: 0 }], updates: [{ t: 60, v: 4 }] }]]);
  q.push("s", { op: "update", point: { t: 60, v: 1 } });
  q.forget("s");
  expect(q.size).toBe(0);
});

test("점 사본은 차트와 같은 규칙으로 바뀌고, 시각으로 찾는다", () => {
  const pts = applyToPoints([{ t: 0, v: 0 }, { t: 60, v: 1 }], { op: "update", point: { t: 60, v: 2 } });
  applyToPoints(pts, { op: "update", point: { t: 120, v: 3 } });
  applyToPoints(pts, { op: "update", point: { t: 30, v: 9 } });
  expect(pts).toEqual([{ t: 0, v: 0 }, { t: 60, v: 2 }, { t: 120, v: 3 }]);
  expect(pointAtTime(pts, 60)?.v).toBe(2);
  expect(pointAtTime(pts, 61)).toBeUndefined();
});

function fakeWorker() {
  const sent: ToWorker[] = [];
  const w: WorkerLike = { postMessage: (m) => sent.push(m), onmessage: null, onerror: null };
  const reply = (m: FromWorker) => w.onmessage?.({ data: m } as MessageEvent<FromWorker>);
  return { w, sent, reply };
}

test("워커는 첫 칸이 열 때 하나 만들고, 응답은 그 칸에만 간다", () => {
  const f = fakeWorker();
  const make = vi.fn(() => f.w);
  const open = createHub(make);
  const one = { message: vi.fn(), broken: vi.fn() };
  const two = { message: vi.fn(), broken: vi.fn() };
  const p1 = open(one);
  const p2 = open(two);
  expect(make).toHaveBeenCalledOnce();
  p1.post({ type: "drop", cell: p1.cell, ids: "all" });
  f.reply({ type: "tail", cell: p2.cell, results: [] });
  expect(two.message).toHaveBeenCalledOnce();
  expect(one.message).not.toHaveBeenCalled();
  p2.close();
  expect(f.sent.at(-1)).toEqual({ type: "drop", cell: p2.cell, ids: "all" });
  f.reply({ type: "tail", cell: p2.cell, results: [] });
  expect(two.message).toHaveBeenCalledOnce();
});

test("wasm init 실패나 워커 오류면 모든 칸이 계산 오류를 알고, 그 뒤로는 보내지 않는다", async () => {
  const f = fakeWorker();
  const open = createHub(() => f.w);
  const one = { message: vi.fn(), broken: vi.fn() };
  const p1 = open(one);
  p1.post({ type: "drop", cell: p1.cell, ids: "all" });
  f.reply({ type: "fatal", message: "init 실패" });
  expect(one.broken).toHaveBeenCalledWith("init 실패");
  f.w.onerror?.({ message: "또" } as ErrorEvent);
  expect(one.broken).toHaveBeenCalledOnce();
  const sent = f.sent.length;
  p1.post({ type: "drop", cell: p1.cell, ids: "all" });
  expect(f.sent).toHaveLength(sent);
  const late = { message: vi.fn(), broken: vi.fn() };
  open(late);
  await Promise.resolve();
  expect(late.broken).toHaveBeenCalledWith("init 실패");
});

test("워커를 만들지 못해도 칸은 계산 오류만 한 번 받는다", async () => {
  const open = createHub(() => {
    throw new Error("Worker 없음");
  });
  const one = { message: vi.fn(), broken: vi.fn() };
  const p = open(one);
  expect(() => p.post({ type: "drop", cell: p.cell, ids: "all" })).not.toThrow();
  await Promise.resolve();
  expect(one.broken).toHaveBeenCalledOnce();
  expect(one.broken).toHaveBeenCalledWith("Worker 없음");
});
