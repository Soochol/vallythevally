import { describe, expect, it } from "vitest";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import { EMPTY_BROKER_STATE, MAX_LIVE_BROKER_COLUMNS, cumulativeAt, halfHourTicks, lineSegments, reduceBrokerEvents, reduceBrokers, sortedRows, startedAt, type BrokerEvent, type BrokerState } from "./model";

const member = (code: string, qty: number) => ({ code, name: `사${code}`, qty, qtyChange: 0 });
const snapshot = (t: number, buys: [string, number][], sells: [string, number][]): BrokerEvent => ({
  type: "snapshot",
  brokers: { t, buys: buys.map(([c, q]) => member(c, q)), sells: sells.map(([c, q]) => member(c, q)) } satisfies FeedBrokers,
});
const run = (events: BrokerEvent[]): BrokerState => events.reduce(reduceBrokers, EMPTY_BROKER_STATE);
const row = (state: BrokerState, code: string) => state.grid.rows.find((r) => r.code === code)!;

describe("거래원 구간 순매수", () => {
  const state = run([
    snapshot(60, [["a", 100]], [["b", 30]]),
    snapshot(120, [["a", 150]], [["b", 80]]),
    snapshot(180, [["a", 130]], [["b", 120]]),
  ]);

  it("당일 누적의 구간 차이로 계산한다", () => {
    expect(row(state, "a").cells.map((c) => c.net)).toEqual([100, 50, -20]);
    expect(row(state, "b").cells.map((c) => c.net)).toEqual([-30, -50, -40]);
  });

  it("매수와 매도에 모두 든 회원사는 매수에서 매도를 뺀다", () => {
    const both = run([snapshot(60, [["a", 100]], [["a", 40]])]);
    expect(row(both, "a").cells[0]?.cumulative).toBe(60);
  });

  it("처음 기록된 칸만 first다", () => {
    expect(row(state, "a").cells.map((c) => c.first)).toEqual([true, false, false]);
  });
});

describe("상위 5 밖 구간", () => {
  const state = run([
    snapshot(60, [["a", 100]], []),
    snapshot(120, [], [["b", 10]]),
    snapshot(180, [["a", 160]], []),
  ]);

  it("밖이던 칸은 값이 없고 선분이 이어지지 않는다", () => {
    expect(row(state, "a").cells.map((c) => c.present)).toEqual([true, false, true]);
    expect(lineSegments(row(state, "a"))).toEqual([{ from: 0, values: [100] }, { from: 2, values: [160] }]);
  });

  it("늦게 든 회원사의 앞 칸은 밖이다", () => {
    expect(row(state, "b").cells.map((c) => c.present)).toEqual([false, true, false]);
  });

  it("다시 든 칸의 순매수는 마지막으로 알던 누적에서 잰다", () => {
    expect(row(state, "a").cells[2]?.net).toBe(60);
  });
});

describe("정렬과 기준 시각", () => {
  const state = run([
    snapshot(60, [["a", 100], ["c", 5]], [["b", 300]]),
    snapshot(120, [["a", 400], ["c", 5]], [["b", 300]]),
  ]);

  it("최종 순매수 절댓값 순이다", () => {
    expect(sortedRows(state.grid).map((r) => r.code)).toEqual(["a", "b", "c"]);
  });

  it("슬라이더 시각의 누적값을 준다", () => {
    expect(cumulativeAt(row(state, "a"), 0)).toBe(100);
    expect(cumulativeAt(row(state, "a"), 1)).toBe(400);
    expect(cumulativeAt(row(state, "b"), 0)).toBe(-300);
  });

  it("밖인 시각은 마지막으로 알던 누적이고 기록 전이면 없다", () => {
    const gapped = run([snapshot(60, [["z", 9]], []), snapshot(120, [["a", 1]], [])]);
    expect(cumulativeAt(row(gapped, "z"), 1)).toBe(9);
    expect(cumulativeAt(row(gapped, "a"), 0)).toBeNull();
  });
});

describe("끊김과 중복", () => {
  it("끊긴 뒤 첫 칸 앞에 끊김을 표시한다", () => {
    const state = run([snapshot(60, [["a", 1]], []), { type: "link", live: false }, { type: "link", live: true }, snapshot(120, [["a", 2]], [])]);
    expect(state.grid.gapBefore).toEqual([false, true]);
  });

  it("다시 연결되며 같은 스냅샷이 오면 칸을 늘리지 않는다", () => {
    const state = run([snapshot(60, [["a", 1]], []), { type: "resync" }, snapshot(60, [["a", 1]], [])]);
    expect(state.grid.times).toEqual([60]);
  });

  it("처음 기록된 시각을 준다", () => {
    expect(startedAt(EMPTY_BROKER_STATE.grid)).toBeNull();
    expect(startedAt(run([snapshot(60, [["a", 1]], [])]).grid)).toBe(60);
  });
});

describe("거래원 시간 눈금", () => {
  const at = (clock: string) => Date.parse(`2026-11-09T${clock}+09:00`) / 1000;

  it("30분 경계를 처음 넘은 스냅샷 칸에 그 경계 시각을 단다", () => {
    const times = [at("09:20:00"), at("09:29:59"), at("09:31:00"), at("09:45:00"), at("10:05:00")];
    expect(halfHourTicks(times)).toEqual([{ column: 2, time: at("09:30:00") }, { column: 4, time: at("10:00:00") }]);
  });

  it("경계 두 개를 한 번에 건너면 마지막 경계 하나만 단다", () => {
    expect(halfHourTicks([at("09:10:00"), at("10:15:00")])).toEqual([{ column: 1, time: at("10:00:00") }]);
  });

  it("스냅샷이 없거나 하나면 눈금이 없다", () => {
    expect(halfHourTicks([])).toEqual([]);
    expect(halfHourTicks([at("09:10:00")])).toEqual([]);
  });
});

describe("실시간 거래원 묶음과 압축", () => {
  it("열 수가 상한을 넘으면 같은 분의 스냅샷을 합쳐 열 수를 줄이고 최종 누적을 유지한다", () => {
    const events: BrokerEvent[] = Array.from({ length: MAX_LIVE_BROKER_COLUMNS + 60 }, (_, i) =>
      snapshot(60 + i * 5, [["a", (i + 1) * 10]], [["b", (i + 1) * 3]]),
    );
    const state = reduceBrokerEvents(EMPTY_BROKER_STATE, events);
    expect(state.grid.times.length).toBeLessThanOrEqual(MAX_LIVE_BROKER_COLUMNS);
    expect(row(state, "a").cells.at(-1)?.cumulative).toBe((MAX_LIVE_BROKER_COLUMNS + 60) * 10);
    expect(row(state, "b").cells.at(-1)?.cumulative).toBe(-(MAX_LIVE_BROKER_COLUMNS + 60) * 3);
  });
});
