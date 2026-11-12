import { describe, expect, test } from "vitest";
import { type Current, EMPTY_HISTORY, HISTORY_LIMIT, historyUndo, planRedo, planUndo, record, sameContent } from "./history";
import type { DrawingBody } from "./types";

const body = (id: string, price: number, revision = 1): DrawingBody => ({
  id,
  symbol: "005930",
  tool: "hline",
  points: [{ t: 1_762_300_800, price }],
  text: null,
  style: { v: 1, line: { color: "$draw", width: 2, dash: "solid" } },
  locked: false,
  hidden: false,
  periods: null,
  z: 1,
  group: null,
  scope: { kind: "symbol" },
  revision,
});

const viewOf = (...bodies: DrawingBody[]): Current => {
  const map = new Map(bodies.map((b) => [b.id, b]));
  return (id) => map.get(id) ?? null;
};

describe("sameContent", () => {
  test("revision·updatedAt은 빼고, 키 순서는 보지 않는다", () => {
    const a = body("a", 100, 1);
    const b = { ...body("a", 100, 999), updatedAt: 5, style: { line: { dash: "solid", width: 2, color: "$draw" }, v: 1 } };
    expect(sameContent(a, b)).toBe(true);
    expect(sameContent(a, body("a", 101))).toBe(false);
    expect(sameContent(a, null)).toBe(false);
    expect(sameContent(null, null)).toBe(true);
  });
});

describe("record", () => {
  test("한 동작이 한 칸이고, 새 기록은 다시 하기를 지운다", () => {
    let h = record(EMPTY_HISTORY, [{ kind: "create", after: body("a", 100) }]);
    const undo = planUndo(h, viewOf(body("a", 100)));
    if (undo.kind !== "apply") throw new Error(undo.kind);
    h = record(undo.history, [{ kind: "create", after: body("b", 100) }]);
    expect(h.future).toEqual([]);
    expect(h.past).toHaveLength(1);
  });

  test("바뀌지 않은 op는 버리고, 남는 것이 없으면 칸을 만들지 않는다", () => {
    const h = record(EMPTY_HISTORY, [{ kind: "update", before: body("a", 100, 1), after: body("a", 100, 2) }]);
    expect(h).toBe(EMPTY_HISTORY);
  });

  test("같은 id의 op는 하나로 합친다", () => {
    const h = record(EMPTY_HISTORY, [
      { kind: "update", before: body("a", 100), after: body("a", 110) },
      { kind: "update", before: body("a", 110), after: body("a", 120) },
      { kind: "create", after: body("b", 1) },
      { kind: "delete", before: body("b", 1) },
    ]);
    expect(h.past).toEqual([[{ kind: "update", before: body("a", 100), after: body("a", 120) }]]);
  });

  test(`최대 ${HISTORY_LIMIT}칸, 오래된 것부터 버린다`, () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i <= HISTORY_LIMIT; i++) h = record(h, [{ kind: "create", after: body(`d${i}`, i) }]);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]?.[0]).toEqual({ kind: "create", after: body("d1", 1) });
  });
});

describe("되돌리기·다시 하기", () => {
  const moved = record(EMPTY_HISTORY, [
    { kind: "update", before: body("a", 100), after: body("a", 120) },
    { kind: "update", before: body("b", 200), after: body("b", 220) },
  ]);

  test("여러 개를 함께 옮긴 것은 한 번에 되돌린다", () => {
    const plan = planUndo(moved, viewOf(body("a", 120, 7), body("b", 220, 8)));
    expect(plan).toEqual({
      kind: "apply",
      ops: [
        { kind: "update", before: body("a", 120), after: body("a", 100) },
        { kind: "update", before: body("b", 220), after: body("b", 200) },
      ],
      history: { past: [], future: moved.past },
    });
  });

  test("다시 하기는 before와 같을 때만 원래 op를 다시 낸다", () => {
    const undone = planUndo(moved, viewOf(body("a", 120), body("b", 220)));
    if (undone.kind !== "apply") throw new Error(undone.kind);
    const redo = planRedo(undone.history, viewOf(body("a", 100), body("b", 200)));
    expect(redo).toEqual({ kind: "apply", ops: moved.past[0], history: moved });
  });

  test("만들기를 되돌리면 지우기, 지우기를 되돌리면 같은 id로 다시 만든다", () => {
    const created = record(EMPTY_HISTORY, [{ kind: "create", after: body("a", 1) }]);
    expect(planUndo(created, viewOf(body("a", 1)))).toMatchObject({ kind: "apply", ops: [{ kind: "delete", before: body("a", 1) }] });
    const deleted = record(EMPTY_HISTORY, [{ kind: "delete", before: body("a", 1) }]);
    expect(planUndo(deleted, viewOf())).toMatchObject({ kind: "apply", ops: [{ kind: "create", after: body("a", 1) }] });
  });

  test("비었으면 할 일이 없다", () => {
    expect(planUndo(EMPTY_HISTORY, viewOf())).toEqual({ kind: "nothing" });
    expect(planRedo(EMPTY_HISTORY, viewOf())).toEqual({ kind: "nothing" });
  });
});

describe("다른 곳에서 바뀐 드로잉(충돌)", () => {
  const moved = record(record(EMPTY_HISTORY, [{ kind: "create", after: body("z", 5) }]), [
    { kind: "update", before: body("a", 100), after: body("a", 120) },
    { kind: "update", before: body("b", 200), after: body("b", 220) },
  ]);

  test("하나라도 after와 다르면 칸을 통째로 버리고 아무것도 적용하지 않는다", () => {
    const plan = planUndo(moved, viewOf(body("a", 120), body("b", 250), body("z", 5)));
    expect(plan).toEqual({ kind: "conflict", ids: ["b"], history: { past: moved.past.slice(0, 1), future: [] } });
  });

  test("다른 탭이 지운 드로잉도 충돌이다", () => {
    expect(planUndo(moved, viewOf(body("a", 120), body("z", 5))).kind).toBe("conflict");
  });

  test("버린 뒤 다음 되돌리기는 그 앞 칸이다", () => {
    const plan = planUndo(moved, viewOf(body("a", 999), body("b", 220), body("z", 5)));
    if (plan.kind !== "conflict") throw new Error(plan.kind);
    expect(planUndo(plan.history, viewOf(body("z", 5)))).toMatchObject({ kind: "apply", ops: [{ kind: "delete" }] });
  });

  test("다시 하기도 before와 다르면 버린다", () => {
    const undone = planUndo(moved, viewOf(body("a", 120), body("b", 220), body("z", 5)));
    if (undone.kind !== "apply") throw new Error(undone.kind);
    const redo = planRedo(undone.history, viewOf(body("a", 100), body("b", 201)));
    expect(redo).toEqual({ kind: "conflict", ids: ["b"], history: { past: undone.history.past, future: [] } });
  });

  test("revision만 다른 것은 충돌이 아니다", () => {
    expect(planUndo(moved, viewOf(body("a", 120, 55), body("b", 220, 66))).kind).toBe("apply");
  });
});


test("삭제 알림은 묶인 기록 하나만 한 번 되돌린다", () => {
  const original = record(EMPTY_HISTORY, [{ kind: "delete", before: body("a", 100) }]);
  let current = original;
  let called = 0;
  const action = historyUndo(() => current, () => { called++; });
  expect(action.available()).toBe(true);
  action.run(); action.run();
  expect(called).toBe(1);
  expect(action.available()).toBe(false);
  const stale = historyUndo(() => current, () => { called++; });
  const plan = planUndo(current, () => null);
  if (plan.kind !== "apply") throw new Error("삭제를 되돌릴 기록이 필요합니다");
  current = plan.history;
  expect(stale.available()).toBe(false); stale.run();
  const redo = planRedo(current, viewOf(body("a", 100)));
  if (redo.kind !== "apply") throw new Error("다시 지울 기록이 필요합니다");
  current = redo.history;
  expect(stale.available()).toBe(false); stale.run();
  expect(called).toBe(1);
});

test("다른 작업이 위에 놓이면 삭제 알림은 이전 작업을 취소할 수 없다", () => {
  let current = record(EMPTY_HISTORY, [{ kind: "delete", before: body("a", 100) }]);
  let called = false;
  const action = historyUndo(() => current, () => { called = true; });
  current = record(current, [{ kind: "create", after: body("b", 200) }]);
  expect(action.available()).toBe(false); action.run();
  expect(called).toBe(false);
  const empty = historyUndo(() => EMPTY_HISTORY, () => { called = true; });
  expect(empty.available()).toBe(false); empty.run();
  expect(called).toBe(false);
});
