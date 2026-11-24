import { describe, expect, it } from "vitest";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import { EMPTY_BROKER_STATE, reduceBrokers } from "./model";
import { barBins, boardAxis, brokerTracks, eventsUntil, isForeignBroker, listOrder, type BrokerTrack } from "./board";

const entry = (code: string, qty: number) => ({ code, name: `사${code}`, qty, qtyChange: 0 });
const feed = (t: number, buys: [string, number][], sells: [string, number][] = []): FeedBrokers => ({ t, buys: buys.map(([c, q]) => entry(c, q)), sells: sells.map(([c, q]) => entry(c, q)) });
const gridOf = (...feeds: FeedBrokers[]) => feeds.reduce((state, brokers) => reduceBrokers(state, { type: "snapshot", brokers }), EMPTY_BROKER_STATE).grid;
const track = (code: string, cumulative: number, events: [number, number][] = []): BrokerTrack => ({ code, name: code, cumulative, events: events.map(([t, net]) => ({ t, net, cumulative: net, first: false, gap: false })) });
const kst = (clock: string) => Date.parse(`2026-11-24T${clock}:00+09:00`) / 1000;

describe("거래원 카드 자료", () => {
  it("거래원 사건은 순매수 변화가 있는 시각만 남고 처음 관측과 끊긴 뒤 관측을 구분한다", () => {
    const tracks = brokerTracks(gridOf(feed(60, [["a", 100]], [["b", 30]]), feed(120, [["a", 150]]), feed(180, [["a", 150]], [["b", 80]])));
    const a = tracks.find((t) => t.code === "a")!;
    const b = tracks.find((t) => t.code === "b")!;
    expect(a.events.map((e) => [e.t, e.net, e.cumulative, e.first, e.gap])).toEqual([[60, 100, 100, true, false], [120, 50, 150, false, false]]);
    expect(b.events.map((e) => [e.t, e.net, e.cumulative, e.first, e.gap])).toEqual([[60, -30, -30, true, false], [180, -50, -80, false, true]]);
    expect(tracks.map((t) => [t.code, t.cumulative])).toEqual([["a", 150], ["b", -80]]);
  });

  it("막대는 시각 구간마다 순매수를 더한다", () => {
    const bins = barBins(track("a", 8, [[10, 5], [290, 7], [300, -4]]), { from: 0, to: 600 }, 300);
    expect(bins).toEqual([12, -4]);
    expect(barBins(track("a", 1, [[600, 1]]), { from: 0, to: 600 }, 300)).toEqual([0, 1]);
  });

  it("숫자 줄은 커서 시각까지의 최근 건부터다", () => {
    const t = track("a", 3, [[10, 1], [20, 1], [30, 1]]);
    expect(eventsUntil(t, 25, 5).map((e) => e.t)).toEqual([20, 10]);
    expect(eventsUntil(t, null, 2).map((e) => e.t)).toEqual([30, 20]);
  });

  it("축은 09:00부터 지금까지이고 마감 뒤는 15:30, 시간외 자료가 있으면 20:00까지다", () => {
    const at = (last: string, now: string) => boardAxis([kst("09:30"), kst(last)], kst(now));
    expect(at("14:19", "14:20")).toEqual({ from: kst("09:00"), to: kst("14:20") });
    expect(at("15:29", "16:00")).toEqual({ from: kst("09:00"), to: kst("15:30") });
    expect(at("17:50", "18:00")).toEqual({ from: kst("09:00"), to: kst("18:00") });
    expect(at("19:50", "22:00")).toEqual({ from: kst("09:00"), to: kst("20:00") });
    expect(boardAxis([kst("08:10"), kst("08:29")], kst("08:30"))).toEqual({ from: kst("08:10"), to: kst("08:30") });
  });

  it("거래원 목록은 순매수가 큰 순이고 순매도와 나뉜다", () => {
    const { rows, sellStart } = listOrder([track("a", -5), track("b", 30), track("c", 7), track("d", -80)]);
    expect(rows.map((r) => r.code)).toEqual(["b", "c", "a", "d"]);
    expect(sellStart).toBe(2);
    expect(listOrder([track("a", 1)]).sellStart).toBe(1);
  });

  it("외국계 이름을 알아본다", () => {
    expect(["JP모간서울", "골드만", "모건스탠리", "키움증권", "신한투자"].map(isForeignBroker)).toEqual([true, true, true, false, false]);
  });
});
