import type { Bar } from "../../api/generated/Bar";
import type { FeedBroker } from "../../api/generated/FeedBroker";
import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { isForeignBroker } from "./board";
import { priceAt } from "./history";

export type TransferLevel = "broker" | "group";
export type TransferMode = "net" | "gross";
export type BrokerGroupKind = "foreign" | "retail" | "domestic" | "other";
export type TransferConfidence = "high" | "medium" | "low";

export interface TransferRange {
  readonly from: UnixSeconds;
  readonly to: UnixSeconds;
}

export interface TransferStep {
  readonly t: UnixSeconds;
  readonly prevT: UnixSeconds;
  readonly price: number;
  readonly vol: number;
  readonly volumeEstimated: boolean;
  readonly gap: boolean;
  readonly grossSellTop5: number;
  readonly grossBuyTop5: number;
  readonly sells: ReadonlyMap<string, number>;
  readonly buys: ReadonlyMap<string, number>;
}

export interface TransferEdge {
  readonly src: string;
  readonly dst: string;
  readonly qty: number;
  readonly valueWon: number;
  readonly peakT: UnixSeconds;
  readonly peakQty: number;
  readonly isOther: boolean;
}

export interface TransferSummary {
  readonly otherLabel: string;
  readonly edges: readonly TransferEdge[];
  readonly srcTotals: ReadonlyMap<string, number>;
  readonly dstTotals: ReadonlyMap<string, number>;
  readonly totalVol: number;
  readonly selfCancelVol: number;
  readonly covSellPct: number;
  readonly covBuyPct: number;
  readonly identifiedPct: number;
  readonly confidence: TransferConfidence;
  readonly skippedGaps: number;
  readonly stepCount: number;
  readonly volumeEstimated: boolean;
}

export interface TransferEvent {
  readonly t: UnixSeconds;
  readonly from: UnixSeconds;
  readonly to: UnixSeconds;
  readonly src: string;
  readonly dst: string;
  readonly qty: number;
  readonly valueWon: number;
  readonly covAvg: number;
  readonly score: number;
}

export interface SankeyNodeLayout {
  readonly side: "src" | "dst";
  readonly name: string;
  readonly group: BrokerGroupKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly qty: number;
  readonly sharePct: number;
  readonly isOther: boolean;
}

export interface SankeyLinkLayout {
  readonly id: string;
  readonly edge: TransferEdge;
  readonly path: string;
  readonly srcSharePct: number;
  readonly dstSharePct: number;
  readonly srcGroup: BrokerGroupKind;
  readonly dstGroup: BrokerGroupKind;
}

export interface TransferSankeyLayout {
  readonly width: number;
  readonly height: number;
  readonly srcNodes: readonly SankeyNodeLayout[];
  readonly dstNodes: readonly SankeyNodeLayout[];
  readonly links: readonly SankeyLinkLayout[];
}

export const OTHER_BROKER_LABEL = "기타(6위↓)";

export const GROUP_LABELS: Record<BrokerGroupKind, string> = {
  foreign: "외국계",
  retail: "리테일 집중",
  domestic: "국내 대형 종합",
  other: OTHER_BROKER_LABEL,
};

const RETAIL_HINTS: readonly string[] = ["키움", "토스", "카카오페이"];
const BAR_PERIOD_SECONDS = 60;
const EVENT_WINDOW_HALF_SECONDS = 180;
const EVENT_MIN_GAP_SECONDS = 180;
const EVENT_MAX_GAP_SECONDS = 1200;
const EVENT_SCORE_THRESHOLD = 1.8;
const MAX_EVENTS = 4;
const MAX_SANKEY_NODES = 7;

export function brokerGroupOf(name: string): BrokerGroupKind {
  if (name === OTHER_BROKER_LABEL || name === GROUP_LABELS.other) return "other";
  if (name === GROUP_LABELS.foreign) return "foreign";
  if (name === GROUP_LABELS.retail) return "retail";
  if (name === GROUP_LABELS.domestic) return "domestic";
  if (isForeignBroker(name)) return "foreign";
  const upper = name.toUpperCase();
  if (RETAIL_HINTS.some((hint) => upper.includes(hint.toUpperCase()))) return "retail";
  return "domestic";
}

function brokerQtyByCode(rows: readonly FeedBroker[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.code, row.qty);
  return map;
}

function sideDeltaMap(
  prevRows: readonly FeedBroker[],
  currRows: readonly FeedBroker[],
): { readonly deltas: Map<string, number>; readonly total: number } {
  const prevByCode = brokerQtyByCode(prevRows);
  const deltas = new Map<string, number>();
  let total = 0;
  for (const row of currRows) {
    const prevQty = prevByCode.get(row.code);
    const delta = prevQty === undefined ? Math.max(0, row.qtyChange) : Math.max(0, row.qty - prevQty);
    if (delta <= 0) continue;
    deltas.set(row.name, (deltas.get(row.name) ?? 0) + delta);
    total += delta;
  }
  return { deltas, total };
}

function intervalBarVolume(bars: readonly Bar[], prevT: UnixSeconds, currT: UnixSeconds): number {
  if (bars.length === 0) return 0;
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t <= prevT) lo = mid + 1;
    else hi = mid;
  }
  let sum = 0;
  let matched = false;
  for (let i = lo; i < bars.length; i++) {
    const bar = bars[i]!;
    if (bar.t > currT) break;
    matched = true;
    sum += Math.max(0, bar.v);
  }
  if (matched) return sum;
  if (currT - prevT < BAR_PERIOD_SECONDS) {
    const coverIndex = lo - 1;
    if (coverIndex >= 0) {
      const coverBar = bars[coverIndex]!;
      if (coverBar.t <= currT && currT - coverBar.t < BAR_PERIOD_SECONDS) {
        return Math.max(0, coverBar.v);
      }
    }
  }
  return 0;
}

export function buildTransferSteps(
  snapshots: readonly FeedBrokers[],
  gapBefore: readonly boolean[],
  bars: readonly Bar[],
): readonly TransferStep[] {
  if (snapshots.length < 2) return [];
  const steps: TransferStep[] = [];
  let prev = snapshots[0]!;
  for (let i = 1; i < snapshots.length; i++) {
    const curr = snapshots[i]!;
    if (curr.t < prev.t) continue;
    const isGap = gapBefore[i] === true;
    const price = priceAt(bars, curr.t) ?? 0;
    if (isGap) {
      steps.push({
        t: curr.t,
        prevT: prev.t,
        price,
        vol: 0,
        volumeEstimated: false,
        gap: true,
        grossSellTop5: 0,
        grossBuyTop5: 0,
        sells: new Map(),
        buys: new Map(),
      });
      prev = curr;
      continue;
    }
    if (curr.t === prev.t) {
      prev = curr;
      continue;
    }
    const sellSide = sideDeltaMap(prev.sells, curr.sells);
    const buySide = sideDeltaMap(prev.buys, curr.buys);
    const barVol = intervalBarVolume(bars, prev.t, curr.t);
    const maxObserved = Math.max(sellSide.total, buySide.total);
    const volumeEstimated = barVol <= 0 && maxObserved > 0;
    const vol = barVol > 0 ? barVol : maxObserved;
    steps.push({
      t: curr.t,
      prevT: prev.t,
      price,
      vol,
      volumeEstimated,
      gap: false,
      grossSellTop5: sellSide.total,
      grossBuyTop5: buySide.total,
      sells: sellSide.deltas,
      buys: buySide.deltas,
    });
    prev = curr;
  }
  return steps;
}

function keyForLevel(name: string, level: TransferLevel): string {
  return level === "broker" ? name : GROUP_LABELS[brokerGroupOf(name)];
}

function otherLabelForLevel(level: TransferLevel): string {
  return level === "broker" ? OTHER_BROKER_LABEL : GROUP_LABELS.other;
}

interface StepFlowBreakdown {
  readonly sMap: Map<string, number>;
  readonly bMap: Map<string, number>;
  readonly vEff: number;
  readonly selfCancel: number;
  readonly otherLabel: string;
}

function computeStepFlows(step: TransferStep, level: TransferLevel, mode: TransferMode): StepFlowBreakdown {
  const otherLabel = otherLabelForLevel(level);
  const rawS = new Map<string, number>();
  const rawB = new Map<string, number>();
  for (const [name, qty] of step.sells) {
    if (qty <= 0) continue;
    const key = keyForLevel(name, level);
    rawS.set(key, (rawS.get(key) ?? 0) + qty);
  }
  for (const [name, qty] of step.buys) {
    if (qty <= 0) continue;
    const key = keyForLevel(name, level);
    rawB.set(key, (rawB.get(key) ?? 0) + qty);
  }

  const sMap = new Map<string, number>();
  const bMap = new Map<string, number>();
  const allKeys = new Set<string>([...rawS.keys(), ...rawB.keys()]);
  let topS = 0;
  let topB = 0;
  let selfCancel = 0;

  for (const key of allKeys) {
    const sq = rawS.get(key) ?? 0;
    const bq = rawB.get(key) ?? 0;
    if (mode === "net") {
      selfCancel += Math.min(sq, bq);
      const diff = bq - sq;
      if (diff < 0) {
        sMap.set(key, -diff);
        topS += -diff;
      } else if (diff > 0) {
        bMap.set(key, diff);
        topB += diff;
      }
    } else {
      if (sq > 0) {
        sMap.set(key, sq);
        topS += sq;
      }
      if (bq > 0) {
        bMap.set(key, bq);
        topB += bq;
      }
    }
  }

  const poolVol = mode === "net" ? Math.max(0, step.vol - selfCancel) : Math.max(0, step.vol);
  if (poolVol <= 0 && topS <= 0 && topB <= 0) {
    return { sMap, bMap, vEff: 0, selfCancel, otherLabel };
  }
  const vEff = Math.max(poolVol, topS, topB, 1);
  const sOther = Math.max(0, vEff - topS);
  const bOther = Math.max(0, vEff - topB);
  if (sOther > 0) sMap.set(otherLabel, (sMap.get(otherLabel) ?? 0) + sOther);
  if (bOther > 0) bMap.set(otherLabel, (bMap.get(otherLabel) ?? 0) + bOther);
  return { sMap, bMap, vEff, selfCancel, otherLabel };
}

interface MutableEdge {
  readonly src: string;
  readonly dst: string;
  qty: number;
  valueWon: number;
  peakT: UnixSeconds;
  peakQty: number;
  readonly isOther: boolean;
}

function classifyConfidence(covSellPct: number, covBuyPct: number, identifiedPct: number): TransferConfidence {
  const avgCov = (covSellPct + covBuyPct) / 2;
  if (avgCov >= 55 && identifiedPct >= 28) return "high";
  if (avgCov >= 35) return "medium";
  return "low";
}

export function computeTransfer(
  steps: readonly TransferStep[],
  range: TransferRange,
  level: TransferLevel,
  mode: TransferMode,
): TransferSummary {
  const otherLabel = otherLabelForLevel(level);
  const edgeMap = new Map<string, MutableEdge>();
  const srcTotals = new Map<string, number>();
  const dstTotals = new Map<string, number>();

  let totalVol = 0;
  let selfCancelVol = 0;
  let totalGrossS = 0;
  let totalGrossB = 0;
  let skippedGaps = 0;
  let stepCount = 0;
  let volumeEstimated = false;

  for (const step of steps) {
    if (step.t < range.from || step.t > range.to) continue;
    if (step.gap) {
      skippedGaps += 1;
      continue;
    }
    stepCount += 1;
    if (step.volumeEstimated) volumeEstimated = true;
    const { sMap, bMap, vEff, selfCancel } = computeStepFlows(step, level, mode);
    totalVol += step.vol;
    selfCancelVol += selfCancel;
    totalGrossS += step.grossSellTop5;
    totalGrossB += step.grossBuyTop5;
    if (vEff <= 0) continue;

    for (const [sKey, sq] of sMap) {
      srcTotals.set(sKey, (srcTotals.get(sKey) ?? 0) + sq);
      for (const [bKey, bq] of bMap) {
        const flow = (sq * bq) / vEff;
        if (flow <= 0) continue;
        const edgeKey = `${sKey}\0${bKey}`;
        let edge = edgeMap.get(edgeKey);
        if (edge === undefined) {
          edge = {
            src: sKey,
            dst: bKey,
            qty: 0,
            valueWon: 0,
            peakT: step.t,
            peakQty: 0,
            isOther: sKey === otherLabel || bKey === otherLabel,
          };
          edgeMap.set(edgeKey, edge);
        }
        edge.qty += flow;
        edge.valueWon += flow * step.price;
        if (flow > edge.peakQty) {
          edge.peakQty = flow;
          edge.peakT = step.t;
        }
      }
    }
    for (const [bKey, bq] of bMap) {
      dstTotals.set(bKey, (dstTotals.get(bKey) ?? 0) + bq);
    }
  }

  const edges: TransferEdge[] = [...edgeMap.values()].sort((a, b) => b.qty - a.qty);
  const covSellPct = totalVol > 0 ? Math.min(100, (totalGrossS / totalVol) * 100) : 0;
  const covBuyPct = totalVol > 0 ? Math.min(100, (totalGrossB / totalVol) * 100) : 0;

  let identifiedFlow = 0;
  let totalFlow = 0;
  for (const edge of edges) {
    totalFlow += edge.qty;
    if (!edge.isOther) identifiedFlow += edge.qty;
  }
  const identifiedPct = totalFlow > 0 ? (identifiedFlow / totalFlow) * 100 : 0;
  const confidence = classifyConfidence(covSellPct, covBuyPct, identifiedPct);

  return {
    otherLabel,
    edges,
    srcTotals,
    dstTotals,
    totalVol,
    selfCancelVol,
    covSellPct,
    covBuyPct,
    identifiedPct,
    confidence,
    skippedGaps,
    stepCount,
    volumeEstimated,
  };
}

export function detectTransferEvents(
  steps: readonly TransferStep[],
  level: TransferLevel,
  mode: TransferMode,
): readonly TransferEvent[] {
  if (steps.length === 0) return [];
  const otherLabel = otherLabelForLevel(level);
  const minT = steps[0]!.t;
  const maxT = steps[steps.length - 1]!.t;
  const span = Math.max(0, maxT - minT);
  const minSeparation = Math.min(EVENT_MAX_GAP_SECONDS, Math.max(EVENT_MIN_GAP_SECONDS, Math.round(span * 0.12)));

  const scored: { readonly t: UnixSeconds; readonly idQty: number; readonly ratio: number; score: number }[] = [];
  for (const step of steps) {
    if (step.gap) continue;
    const { sMap, bMap, vEff } = computeStepFlows(step, level, mode);
    if (vEff <= 0) continue;
    let idQty = 0;
    for (const [sKey, sq] of sMap) {
      if (sKey === otherLabel) continue;
      for (const [bKey, bq] of bMap) {
        if (bKey === otherLabel) continue;
        idQty += (sq * bq) / vEff;
      }
    }
    if (idQty <= 0) continue;
    scored.push({ t: step.t, idQty, ratio: idQty / vEff, score: 0 });
  }
  if (scored.length === 0) return [];

  const nonZero = scored.map((item) => item.idQty).sort((a, b) => a - b);
  const median = nonZero[Math.floor(nonZero.length / 2)] ?? 1;
  for (const item of scored) {
    item.score = (item.idQty / Math.max(median, 1)) * (0.4 + item.ratio);
  }

  const candidates = scored
    .filter((item) => item.score > EVENT_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const picked: TransferEvent[] = [];
  for (const cand of candidates) {
    if (!picked.every((existing) => Math.abs(existing.t - cand.t) >= minSeparation)) continue;
    const from = Math.max(minT, cand.t - EVENT_WINDOW_HALF_SECONDS);
    const to = Math.min(maxT, cand.t + EVENT_WINDOW_HALF_SECONDS);
    const sub = computeTransfer(steps, { from, to }, level, mode);
    const bestEdge = sub.edges.find((edge) => !edge.isOther);
    if (bestEdge === undefined) continue;
    picked.push({
      t: cand.t,
      from,
      to,
      src: bestEdge.src,
      dst: bestEdge.dst,
      qty: bestEdge.qty,
      valueWon: bestEdge.valueWon,
      covAvg: (sub.covSellPct + sub.covBuyPct) / 2,
      score: cand.score,
    });
    if (picked.length >= MAX_EVENTS) break;
  }

  return picked.sort((a, b) => a.t - b.t);
}

function selectSideKeys(
  totals: ReadonlyMap<string, number>,
  otherLabel: string,
  showOther: boolean,
): readonly string[] {
  const nonOther = [...totals.entries()]
    .filter(([name, qty]) => qty > 0 && name !== otherLabel)
    .sort((a, b) => b[1] - a[1]);
  const hasOther = showOther && (totals.get(otherLabel) ?? 0) > 0;
  const maxNamed = hasOther ? MAX_SANKEY_NODES - 1 : MAX_SANKEY_NODES;
  const keys = nonOther.slice(0, maxNamed).map(([name]) => name);
  if (hasOther) keys.push(otherLabel);
  return keys;
}

function buildSideNodes(
  side: "src" | "dst",
  keys: readonly string[],
  visSums: ReadonlyMap<string, number>,
  otherLabel: string,
  x: number,
  nodeW: number,
  height: number,
  padTop: number,
  padBottom: number,
  nodeGap: number,
): readonly SankeyNodeLayout[] {
  const activeKeys = keys.filter((key) => (visSums.get(key) ?? 0) > 0);
  if (activeKeys.length === 0) return [];
  const usableH = Math.max(1, height - padTop - padBottom - nodeGap * Math.max(0, activeKeys.length - 1));
  let total = 0;
  for (const key of activeKeys) total += visSums.get(key) ?? 0;
  if (total <= 0) return [];

  const minNodeH = Math.min(14, usableH / activeKeys.length);
  const rawHeights = activeKeys.map((key) => Math.max(minNodeH, ((visSums.get(key) ?? 0) / total) * usableH));
  const rawSum = rawHeights.reduce((acc, value) => acc + value, 0);
  const scale = usableH / Math.max(rawSum, 1);

  let y = padTop;
  return activeKeys.map((name, index) => {
    const qty = visSums.get(name) ?? 0;
    const nodeH = rawHeights[index]! * scale;
    const node: SankeyNodeLayout = {
      side,
      name,
      group: brokerGroupOf(name),
      x,
      y,
      width: nodeW,
      height: nodeH,
      qty,
      sharePct: (qty / total) * 100,
      isOther: name === otherLabel,
    };
    y += nodeH + nodeGap;
    return node;
  });
}

export function layoutSankey(
  summary: TransferSummary,
  showOther: boolean,
  width: number,
  height: number,
): TransferSankeyLayout {
  if (width <= 0 || height <= 0 || summary.edges.length === 0) {
    return { width, height, srcNodes: [], dstNodes: [], links: [] };
  }
  const padTop = 22;
  const padBottom = 10;
  const nodeW = width < 420 ? 10 : 14;
  const nodeGap = height < 240 ? 5 : 8;
  const labelSpace = Math.min(156, Math.max(88, Math.round(width * 0.25)));
  const leftX = labelSpace;
  const rightX = Math.max(leftX + nodeW * 3, width - labelSpace);

  const srcKeys = selectSideKeys(summary.srcTotals, summary.otherLabel, showOther);
  const dstKeys = selectSideKeys(summary.dstTotals, summary.otherLabel, showOther);
  const srcSet = new Set(srcKeys);
  const dstSet = new Set(dstKeys);

  const visibleEdges = summary.edges.filter((edge) => srcSet.has(edge.src) && dstSet.has(edge.dst) && edge.qty > 0);
  if (visibleEdges.length === 0) {
    return { width, height, srcNodes: [], dstNodes: [], links: [] };
  }

  const visSrcSum = new Map<string, number>();
  const visDstSum = new Map<string, number>();
  for (const edge of visibleEdges) {
    visSrcSum.set(edge.src, (visSrcSum.get(edge.src) ?? 0) + edge.qty);
    visDstSum.set(edge.dst, (visDstSum.get(edge.dst) ?? 0) + edge.qty);
  }

  const srcNodes = buildSideNodes("src", srcKeys, visSrcSum, summary.otherLabel, leftX, nodeW, height, padTop, padBottom, nodeGap);
  const dstNodes = buildSideNodes("dst", dstKeys, visDstSum, summary.otherLabel, rightX - nodeW, nodeW, height, padTop, padBottom, nodeGap);

  const srcNodeMap = new Map(srcNodes.map((node, index) => [node.name, { node, index }]));
  const dstNodeMap = new Map(dstNodes.map((node, index) => [node.name, { node, index }]));

  const orderedEdges = [...visibleEdges].sort((a, b) => {
    const srcDiff = (srcNodeMap.get(a.src)?.index ?? 0) - (srcNodeMap.get(b.src)?.index ?? 0);
    if (srcDiff !== 0) return srcDiff;
    return (dstNodeMap.get(a.dst)?.index ?? 0) - (dstNodeMap.get(b.dst)?.index ?? 0);
  });

  const srcCursors = new Map(srcNodes.map((node) => [node.name, node.y]));
  const dstCursors = new Map(dstNodes.map((node) => [node.name, node.y]));
  const x0 = leftX + nodeW;
  const x1 = rightX - nodeW;
  const cx = (x0 + x1) / 2;

  const links: SankeyLinkLayout[] = [];
  for (const edge of orderedEdges) {
    const srcEntry = srcNodeMap.get(edge.src);
    const dstEntry = dstNodeMap.get(edge.dst);
    if (srcEntry === undefined || dstEntry === undefined) continue;
    const srcNode = srcEntry.node;
    const dstNode = dstEntry.node;
    if (srcNode.qty <= 0 || dstNode.qty <= 0) continue;

    const sy0 = srcCursors.get(edge.src) ?? srcNode.y;
    const dy0 = dstCursors.get(edge.dst) ?? dstNode.y;
    const sy1 = sy0 + (edge.qty / srcNode.qty) * srcNode.height;
    const dy1 = dy0 + (edge.qty / dstNode.qty) * dstNode.height;
    srcCursors.set(edge.src, sy1);
    dstCursors.set(edge.dst, dy1);

    const path = `M ${x0.toFixed(1)} ${sy0.toFixed(1)} C ${cx.toFixed(1)} ${sy0.toFixed(1)}, ${cx.toFixed(1)} ${dy0.toFixed(1)}, ${x1.toFixed(1)} ${dy0.toFixed(1)} L ${x1.toFixed(1)} ${dy1.toFixed(1)} C ${cx.toFixed(1)} ${dy1.toFixed(1)}, ${cx.toFixed(1)} ${sy1.toFixed(1)}, ${x0.toFixed(1)} ${sy1.toFixed(1)} Z`;
    links.push({
      id: `${edge.src}=>${edge.dst}`,
      edge,
      path,
      srcSharePct: (edge.qty / srcNode.qty) * 100,
      dstSharePct: (edge.qty / dstNode.qty) * 100,
      srcGroup: srcNode.group,
      dstGroup: dstNode.group,
    });
  }

  return { width, height, srcNodes, dstNodes, links };
}
