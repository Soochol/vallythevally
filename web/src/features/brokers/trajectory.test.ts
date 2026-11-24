import { describe, expect, it } from "vitest";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import { EMPTY_BROKER_STATE, reduceBrokers, type BrokerEvent } from "./model";
import { brokerTracks, foreignSum, trackRuns } from "./board";

const entry = (code: string, name: string, qty: number) => ({ code, name, qty, qtyChange: 0 });
const snap = (t: number, buys: [string, string, number][], sells: [string, string, number][] = []): BrokerEvent => ({
  type: "snapshot",
  brokers: { t, buys: buys.map(([c, n, q]) => entry(c, n, q)), sells: sells.map(([c, n, q]) => entry(c, n, q)) } satisfies FeedBrokers,
});
const gridOf = (...events: BrokerEvent[]) => events.reduce(reduceBrokers, EMPTY_BROKER_STATE).grid;

describe("거래원 궤적과 외국계 합계", () => {
  it("변화 없는 관측도 궤적의 이어진 구간에 남고 이탈이나 끊김에서만 나뉜다", () => {
    const split = gridOf(
      snap(60, [["a", "키움", 100]]),
      snap(120, [["a", "키움", 100]]),
      snap(180, [["b", "삼성", 10]]),
      snap(240, [["a", "키움", 100]]),
      snap(300, [["a", "키움", 150]]),
    );
    expect(trackRuns(split).get("a")).toEqual([
      { points: [{ t: 60, cumulative: 100 }, { t: 120, cumulative: 100 }] },
      { points: [{ t: 240, cumulative: 100 }, { t: 300, cumulative: 150 }] },
    ]);

    const step = gridOf(
      snap(60, [["a", "키움", 100]]),
      snap(120, [["a", "키움", 100]]),
      snap(180, [["a", "키움", 1000]]),
    );
    expect(trackRuns(step).get("a")).toEqual([
      { points: [{ t: 60, cumulative: 100 }, { t: 120, cumulative: 100 }, { t: 180, cumulative: 1000 }] },
    ]);

    const single = gridOf(snap(60, [["a", "키움", 100]]));
    expect(trackRuns(single).get("a")).toEqual([
      { points: [{ t: 60, cumulative: 100 }] },
    ]);
  });

  it("이탈이나 끊김 뒤 변화가 0인 관측을 지나도 다음 사건이 gap이다", () => {
    const absent = gridOf(
      snap(60, [["a", "키움", 100]]),
      snap(120, [["b", "삼성", 10]]),
      snap(180, [["a", "키움", 100]]),
      snap(240, [["a", "키움", 150]]),
    );
    const absentTrack = brokerTracks(absent).find((t) => t.code === "a")!;
    expect(absentTrack.events.find((e) => e.t === 240)?.gap).toBe(true);

    const disconnected = gridOf(
      snap(60, [["a", "키움", 100]]),
      { type: "link", live: false },
      { type: "link", live: true },
      snap(180, [["a", "키움", 100]]),
      snap(240, [["a", "키움", 150]]),
    );
    const disconnectedTrack = brokerTracks(disconnected).find((t) => t.code === "a")!;
    expect(disconnectedTrack.events.find((e) => e.t === 240)?.gap).toBe(true);
  });

  it("외국계가 관측되기 전 커서에서 외국계 합계는 없음이다", () => {
    const tracks = brokerTracks(gridOf(
      snap(100, [["k", "키움", 700]]),
      snap(200, [["k", "키움", 700], ["j", "JP모간", 250]]),
    ));
    expect(foreignSum(tracks, 150)).toBeNull();
    expect(foreignSum(tracks, null)).toBe(250);
  });
});
