import { describe, expect, it } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import type { FeedBroker } from "../../api/generated/FeedBroker";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import {
  OTHER_BROKER_LABEL,
  brokerGroupOf,
  buildTransferSteps,
  computeTransfer,
  detectTransferEvents,
  layoutSankey,
  type TransferMode,
  type TransferSummary,
} from "./transfer";

const kst = (clock: string) => Date.parse(`2026-11-24T${clock}:00+09:00`) / 1000;

const row = (code: string, name: string, qty: number, qtyChange = 0): FeedBroker => ({
  code,
  name,
  qty,
  qtyChange,
});

const snap = (t: number, sells: FeedBroker[], buys: FeedBroker[]): FeedBrokers => ({
  t,
  sells,
  buys,
});

const bar = (t: number, close: number, volume: number): Bar => ({
  t,
  o: close,
  h: close,
  l: close,
  c: close,
  v: volume,
});

function sumMap(map: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function sumEdges(summary: TransferSummary): number {
  return summary.edges.reduce((acc, edge) => acc + edge.qty, 0);
}

describe("거래원 물량 이동 추정 엔진", () => {
  it("모든 모드(net/gross)에서 개별 창구 기준 질량 보존을 정확히 지킨다", () => {
    const t0 = kst("09:00");
    const t1 = kst("09:01");
    const t2 = kst("09:02");
    const snapshots: FeedBrokers[] = [
      snap(
        t0,
        [row("01", "키움증권", 1000), row("02", "미래에셋", 500)],
        [row("01", "키움증권", 400), row("03", "JP모간서울", 600)],
      ),
      snap(
        t1,
        [row("01", "키움증권", 1600), row("02", "미래에셋", 900)],
        [row("01", "키움증권", 600), row("03", "JP모간서울", 1100), row("04", "KB증권", 300, 300)],
      ),
      snap(
        t2,
        [row("01", "키움증권", 1900), row("05", "유비에스증권", 400, 250)],
        [row("03", "JP모간서울", 1400), row("04", "KB증권", 500)],
      ),
    ];
    const bars: Bar[] = [
      bar(t0, 50000, 1000),
      bar(t1, 50200, 2000),
      bar(t2, 50500, 1200),
    ];

    const steps = buildTransferSteps(snapshots, [false, false, false], bars);
    expect(steps).toHaveLength(2);

    const modes: readonly TransferMode[] = ["net", "gross"];
    for (const mode of modes) {
      const summary = computeTransfer(steps, { from: t1, to: t2 }, mode);
      const srcSum = sumMap(summary.srcTotals);
      const dstSum = sumMap(summary.dstTotals);
      const edgeSum = sumEdges(summary);
      expect(srcSum).toBeGreaterThan(0);
      expect(Math.abs(srcSum - dstSum)).toBeLessThan(1e-6);
      expect(Math.abs(srcSum - edgeSum)).toBeLessThan(1e-6);
    }
  });

  it("오전 매도 A와 오후 매수 B는 시간 적분에서 직접 연결되지 않는다", () => {
    const t0 = kst("09:00");
    const t1 = kst("09:05");
    const t2 = kst("14:00");
    const t3 = kst("14:05");
    const snapshots: FeedBrokers[] = [
      snap(t0, [row("01", "키움증권", 100)], [row("02", "KB증권", 100)]),
      snap(t1, [row("01", "키움증권", 1100)], [row("02", "KB증권", 1100)]),
      snap(t2, [row("01", "키움증권", 1100), row("03", "미래에셋", 100)], [row("02", "KB증권", 1100), row("04", "JP모간서울", 100)]),
      snap(t3, [row("01", "키움증권", 1100), row("03", "미래에셋", 1100)], [row("02", "KB증권", 1100), row("04", "JP모간서울", 1100)]),
    ];
    const bars: Bar[] = [
      bar(t0, 70000, 500),
      bar(t1, 70100, 1000),
      bar(t2, 70500, 0),
      bar(t3, 71000, 1000),
    ];

    const steps = buildTransferSteps(snapshots, [false, false, false, false], bars);
    const summary = computeTransfer(steps, { from: t0, to: t3 }, "net");

    const crossEdge = summary.edges.find((edge) => edge.src === "키움증권" && edge.dst === "JP모간서울");
    const morningEdge = summary.edges.find((edge) => edge.src === "키움증권" && edge.dst === "KB증권");
    const afternoonEdge = summary.edges.find((edge) => edge.src === "미래에셋" && edge.dst === "JP모간서울");

    expect(crossEdge).toBeUndefined();
    expect(morningEdge?.qty).toBeCloseTo(1000, 6);
    expect(afternoonEdge?.qty).toBeCloseTo(1000, 6);
  });

  it("신규 Top5 진입(rank-in) 창구는 누적 qty가 아니라 qtyChange만 반영한다", () => {
    const t0 = kst("10:00");
    const t1 = kst("10:01");
    const snapshots: FeedBrokers[] = [
      snap(t0, [row("01", "키움증권", 5000)], [row("02", "골드만삭스", 5000)]),
      snap(
        t1,
        [row("01", "키움증권", 6000), row("99", "CLSA", 148968, 2896)],
        [row("02", "골드만삭스", 8896)],
      ),
    ];
    const bars: Bar[] = [bar(t0, 100000, 5000), bar(t1, 100500, 5000)];

    const steps = buildTransferSteps(snapshots, [false, false], bars);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.sells.get("CLSA")).toBe(2896);
    expect(steps[0]!.sells.get("키움증권")).toBe(1000);
    expect(steps[0]!.grossSellTop5).toBe(3896);
  });

  it("수집 끊김(gapBefore) 직후의 누적 점프는 제외하고 skippedGaps를 센다", () => {
    const t0 = kst("10:00");
    const t1 = kst("10:01");
    const t2 = kst("11:00");
    const t3 = kst("11:01");
    const snapshots: FeedBrokers[] = [
      snap(t0, [row("01", "키움증권", 100)], [row("02", "JP모간서울", 100)]),
      snap(t1, [row("01", "키움증권", 300)], [row("02", "JP모간서울", 300)]),
      snap(t2, [row("01", "키움증권", 50300)], [row("02", "JP모간서울", 50300)]),
      snap(t3, [row("01", "키움증권", 50500)], [row("02", "JP모간서울", 50500)]),
    ];
    const bars: Bar[] = [
      bar(t0, 50000, 200),
      bar(t1, 50000, 200),
      bar(t2, 51000, 50000),
      bar(t3, 51000, 200),
    ];

    const steps = buildTransferSteps(snapshots, [false, false, true, false], bars);
    expect(steps.filter((step) => step.gap)).toHaveLength(1);

    const summary = computeTransfer(steps, { from: t0, to: t3 }, "net");
    expect(summary.skippedGaps).toBe(1);
    expect(summary.stepCount).toBe(2);
    expect(summary.totalVol).toBe(400);
    expect(summary.srcTotals.get("키움증권")).toBeCloseTo(400, 6);
    expect(summary.dstTotals.get("JP모간서울")).toBeCloseTo(400, 6);
  });

  it("순이동 모드에서 양방향 상쇄량은 selfCancelVol로 분리하고 기타(6위↓)를 부풀리지 않는다", () => {
    const t0 = kst("09:30");
    const t1 = kst("09:31");
    const snapshots: FeedBrokers[] = [
      snap(t0, [row("01", "키움증권", 1000)], [row("01", "키움증권", 1000), row("02", "JP모간서울", 500)]),
      snap(t1, [row("01", "키움증권", 1600)], [row("01", "키움증권", 1400), row("02", "JP모간서울", 700)]),
    ];
    const bars: Bar[] = [bar(t0, 60000, 1000), bar(t1, 60000, 600)];

    const steps = buildTransferSteps(snapshots, [false, false], bars);
    const netSummary = computeTransfer(steps, { from: t0, to: t1 }, "net");
    const grossSummary = computeTransfer(steps, { from: t0, to: t1 }, "gross");

    expect(netSummary.selfCancelVol).toBe(400);
    expect(netSummary.srcTotals.get("키움증권")).toBeCloseTo(200, 6);
    expect(netSummary.dstTotals.get("JP모간서울")).toBeCloseTo(200, 6);
    expect(netSummary.srcTotals.get(OTHER_BROKER_LABEL) ?? 0).toBe(0);
    expect(netSummary.dstTotals.get(OTHER_BROKER_LABEL) ?? 0).toBe(0);

    expect(grossSummary.selfCancelVol).toBe(0);
    const selfLoop = grossSummary.edges.find((edge) => edge.src === "키움증권" && edge.dst === "키움증권");
    expect(selfLoop?.qty).toBeCloseTo(400, 6);
  });

  it("동시 급증 구간에서 Co-Spike 이벤트를 포착하고 ±3분 확대 범위를 반환한다", () => {
    const base = kst("09:00");
    const snapshots: FeedBrokers[] = [];
    const bars: Bar[] = [];
    let sellA = 0;
    let buyB = 0;

    for (let m = 0; m <= 60; m++) {
      const t = base + m * 60;
      const isSpike = m === 30;
      const delta = isSpike ? 2500 : 100;
      const vol = isSpike ? 3000 : 600;
      if (m > 0) {
        sellA += delta;
        buyB += delta;
      }
      snapshots.push(
        snap(t, [row("01", "유비에스증권", sellA)], [row("02", "JP모간서울", buyB)]),
      );
      bars.push(bar(t, 80000, vol));
    }

    const steps = buildTransferSteps(snapshots, snapshots.map(() => false), bars);
    const events = detectTransferEvents(steps, "net");

    expect(events).toHaveLength(1);
    const spike = events[0]!;
    const spikeT = base + 30 * 60;
    expect(spike.t).toBe(spikeT);
    expect(spike.from).toBe(spikeT - 180);
    expect(spike.to).toBe(spikeT + 180);
    expect(spike.src).toBe("유비에스증권");
    expect(spike.dst).toBe("JP모간서울");
    expect(spike.score).toBeGreaterThan(1.8);
  });

  it("포착률과 확인 이동 비중에 따라 신뢰도를 high, medium, low로 분류한다", () => {
    const makeScenario = (topQty: number, totalBarVol: number) => {
      const t0 = kst("10:00");
      const t1 = kst("10:01");
      const snapshots = [
        snap(t0, [row("01", "키움증권", 0)], [row("02", "골드만삭스", 0)]),
        snap(t1, [row("01", "키움증권", topQty)], [row("02", "골드만삭스", topQty)]),
      ];
      const bars = [bar(t0, 50000, totalBarVol), bar(t1, 50000, totalBarVol)];
      const steps = buildTransferSteps(snapshots, [false, false], bars);
      return computeTransfer(steps, { from: t0, to: t1 }, "net");
    };

    const high = makeScenario(700, 1000);
    expect(high.covSellPct).toBeCloseTo(70, 5);
    expect(high.covBuyPct).toBeCloseTo(70, 5);
    expect(high.identifiedPct).toBeCloseTo(49, 5);
    expect(high.confidence).toBe("high");

    const medium = makeScenario(450, 1000);
    expect(medium.covSellPct).toBeCloseTo(45, 5);
    expect(medium.confidence).toBe("medium");

    const low = makeScenario(200, 1000);
    expect(low.covSellPct).toBeCloseTo(20, 5);
    expect(low.confidence).toBe("low");
  });

  it("스냅샷이 1개 이하이거나 1분봉 거래량이 없을 때 NaN 없이 안전하게 처리한다", () => {
    const t0 = kst("09:00");
    const t1 = kst("09:01");
    expect(buildTransferSteps([], [], [])).toEqual([]);
    expect(buildTransferSteps([snap(t0, [row("01", "키움증권", 100)], [])], [false], [])).toEqual([]);

    const noBarSteps = buildTransferSteps(
      [
        snap(t0, [row("01", "키움증권", 100)], [row("02", "토스증권", 100)]),
        snap(t1, [row("01", "키움증권", 400)], [row("02", "토스증권", 300)]),
      ],
      [false, false],
      [],
    );
    expect(noBarSteps).toHaveLength(1);
    expect(noBarSteps[0]!.volumeEstimated).toBe(true);
    expect(noBarSteps[0]!.vol).toBe(300);

    const summary = computeTransfer(noBarSteps, { from: t0, to: t1 }, "net");
    expect(summary.volumeEstimated).toBe(true);
    expect(Number.isNaN(summary.identifiedPct)).toBe(false);
    expect(Number.isNaN(summary.covSellPct)).toBe(false);
  });

  it("창구 색상 분류와 Sankey 레이아웃에서 기타(6위↓)가 맨 아래에 고정된다", () => {
    expect(brokerGroupOf("JP모간서울")).toBe("foreign");
    expect(brokerGroupOf("키움증권")).toBe("retail");
    expect(brokerGroupOf("토스증권")).toBe("retail");
    expect(brokerGroupOf("카카오페이증권")).toBe("retail");
    expect(brokerGroupOf("미래에셋")).toBe("domestic");
    expect(brokerGroupOf(OTHER_BROKER_LABEL)).toBe("other");

    const t0 = kst("09:00");
    const t1 = kst("09:01");
    const steps = buildTransferSteps(
      [
        snap(t0, [row("01", "키움증권", 0)], [row("02", "JP모간서울", 0)]),
        snap(t1, [row("01", "키움증권", 300)], [row("02", "JP모간서울", 250)]),
      ],
      [false, false],
      [bar(t0, 50000, 1000), bar(t1, 50000, 1000)],
    );
    const summary = computeTransfer(steps, { from: t0, to: t1 }, "net");

    const withOther = layoutSankey(summary, true, 820, 340);
    expect(withOther.srcNodes[withOther.srcNodes.length - 1]!.name).toBe(OTHER_BROKER_LABEL);
    expect(withOther.dstNodes[withOther.dstNodes.length - 1]!.name).toBe(OTHER_BROKER_LABEL);
    expect(withOther.links.length).toBeGreaterThan(0);

    const withoutOther = layoutSankey(summary, false, 820, 340);
    expect(withoutOther.srcNodes.some((node) => node.isOther)).toBe(false);
    expect(withoutOther.dstNodes.some((node) => node.isOther)).toBe(false);
  });
});
