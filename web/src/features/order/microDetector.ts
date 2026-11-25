import type { MicroEvent } from "../../api/generated/MicroEvent";
import type { MicroSide } from "../../api/generated/MicroSide";
import type { OfiSnapshot } from "../../api/generated/OfiSnapshot";
import { formatPrice } from "../../lib/format";

export interface MicroBookLevel {
  readonly priceWon: number;
  readonly qty: number;
}

export interface MicroCue {
  readonly event: MicroEvent;
  readonly title: string;
}

const BPS_SCALE = 10_000;
const SINGLE_PRICE_MAX_LEVELS = 3;
const SPOOF_MIN_DROP_QTY = 1_000;
const SPOOF_MIN_CANCEL_RATIO_BPS = 8_000;
const ICEBERG_MIN_EXEC_QTY = 500;
const ICEBERG_MIN_RATIO_BPS = 15_000;
const OFI_WINDOW_MS = 10_000;
const TAPE_BASELINE_WINDOW_MS = 60_000;

export function formatMicroCueTitle(event: MicroEvent): string {
  const sideLabel = event.side === "ask" ? "매도" : "매수";
  const priceText = `${formatPrice(event.priceWon, false)}원`;
  if (event.kind === "spoof_cancel") {
    const cancelPct = Math.round(event.ratioBps / 100);
    return `허수 취소 · ${sideLabel} ${priceText} · 취소율 ${cancelPct}% (취소 ${event.cancelledOrAbsorbedQty.toLocaleString("ko-KR")}주 / 체결 ${event.executedQty.toLocaleString("ko-KR")}주)`;
  }
  const multiple = (event.ratioBps / BPS_SCALE).toFixed(1);
  return `아이스버그 흡수 · ${sideLabel} ${priceText} · 흡수 ${multiple}x (체결 ${event.executedQty.toLocaleString("ko-KR")}주 / 표출 ${event.displayedQty.toLocaleString("ko-KR")}주)`;
}

export function toMicroCue(event: MicroEvent): MicroCue {
  return { event, title: formatMicroCueTitle(event) };
}

function bestAsk(levels: readonly MicroBookLevel[]): MicroBookLevel | null {
  let best: MicroBookLevel | null = null;
  let fallback: MicroBookLevel | null = null;
  for (const level of levels) {
    if (level.priceWon <= 0) continue;
    if (fallback === null || level.priceWon < fallback.priceWon) fallback = level;
    if (level.qty > 0 && (best === null || level.priceWon < best.priceWon)) best = level;
  }
  return best ?? fallback;
}

function bestBid(levels: readonly MicroBookLevel[]): MicroBookLevel | null {
  let best: MicroBookLevel | null = null;
  let fallback: MicroBookLevel | null = null;
  for (const level of levels) {
    if (level.priceWon <= 0) continue;
    if (fallback === null || level.priceWon > fallback.priceWon) fallback = level;
    if (level.qty > 0 && (best === null || level.priceWon > best.priceWon)) best = level;
  }
  return best ?? fallback;
}

function computeOfiDelta(
  prevAsks: readonly MicroBookLevel[],
  prevBids: readonly MicroBookLevel[],
  currAsks: readonly MicroBookLevel[],
  currBids: readonly MicroBookLevel[],
): number | null {
  const prevBid = bestBid(prevBids);
  const currBid = bestBid(currBids);
  const prevAsk = bestAsk(prevAsks);
  const currAsk = bestAsk(currAsks);
  if (!prevBid || !currBid || !prevAsk || !currAsk) return null;

  const bidDelta = currBid.priceWon > prevBid.priceWon
    ? currBid.qty
    : currBid.priceWon === prevBid.priceWon
      ? currBid.qty - prevBid.qty
      : -prevBid.qty;

  const askDelta = currAsk.priceWon < prevAsk.priceWon
    ? currAsk.qty
    : currAsk.priceWon === prevAsk.priceWon
      ? currAsk.qty - prevAsk.qty
      : -prevAsk.qty;

  return bidDelta - askDelta;
}

export class ClientMicroDetector {
  private prevAsks: MicroBookLevel[] = [];
  private prevBids: MicroBookLevel[] = [];
  private readonly askExec = new Map<number, number>();
  private readonly bidExec = new Map<number, number>();
  private readonly ofiSamples: { recvMs: number; delta: number }[] = [];
  private ofiSum = 0;
  private ofiAbsSum = 0;
  private readonly recentTrades: number[] = [];
  private readonly baselineTrades: number[] = [];
  private firstTradeMs: number | null = null;

  reset(): void {
    this.prevAsks = [];
    this.prevBids = [];
    this.askExec.clear();
    this.bidExec.clear();
    this.ofiSamples.length = 0;
    this.ofiSum = 0;
    this.ofiAbsSum = 0;
    this.recentTrades.length = 0;
    this.baselineTrades.length = 0;
    this.firstTradeMs = null;
  }

  onTrade(recvMs: number, priceWon: number, signedQty: number): void {
    if (priceWon <= 0 || signedQty === 0) return;
    const qty = Math.abs(signedQty);
    const map = signedQty > 0 ? this.askExec : this.bidExec;
    map.set(priceWon, (map.get(priceWon) ?? 0) + qty);
    if (this.firstTradeMs === null) this.firstTradeMs = recvMs;
    this.recentTrades.push(recvMs);
    this.baselineTrades.push(recvMs);
    this.evictTrades(recvMs);
  }

  onBook(recvMs: number, asks: readonly MicroBookLevel[], bids: readonly MicroBookLevel[]): { events: MicroEvent[]; ofi: OfiSnapshot } {
    this.evictOfi(recvMs);
    this.evictTrades(recvMs);

    const validAsks = asks.filter((level) => level.priceWon > 0);
    const validBids = bids.filter((level) => level.priceWon > 0);
    const activeAskCount = validAsks.filter((level) => level.qty > 0).length;
    const activeBidCount = validBids.filter((level) => level.qty > 0).length;
    if (activeAskCount <= SINGLE_PRICE_MAX_LEVELS && activeBidCount <= SINGLE_PRICE_MAX_LEVELS) {
      this.prevAsks = [];
      this.prevBids = [];
      this.askExec.clear();
      this.bidExec.clear();
      return { events: [], ofi: this.snapshotOfi(recvMs) };
    }

    const events: MicroEvent[] = [];
    if (this.prevAsks.length > 0 || this.prevBids.length > 0) {
      const delta = computeOfiDelta(this.prevAsks, this.prevBids, validAsks, validBids);
      if (delta !== null && delta !== 0) {
        this.ofiSamples.push({ recvMs, delta });
        this.ofiSum += delta;
        this.ofiAbsSum += Math.abs(delta);
      }
      this.detectSide(recvMs, "ask", this.prevAsks, validAsks, this.askExec, events);
      this.detectSide(recvMs, "bid", this.prevBids, validBids, this.bidExec, events);
    }

    this.prevAsks = validAsks;
    this.prevBids = validBids;
    this.askExec.clear();
    this.bidExec.clear();

    return { events, ofi: this.snapshotOfi(recvMs) };
  }

  private detectSide(
    recvMs: number,
    side: MicroSide,
    prevLevels: readonly MicroBookLevel[],
    currLevels: readonly MicroBookLevel[],
    execMap: ReadonlyMap<number, number>,
    out: MicroEvent[],
  ): void {
    const currByPrice = new Map<number, number>();
    let boundary: number | null = null;
    for (const level of currLevels) {
      currByPrice.set(level.priceWon, level.qty);
      if (level.qty <= 0) continue;
      if (side === "ask") {
        if (boundary === null || level.priceWon > boundary) boundary = level.priceWon;
      } else if (boundary === null || level.priceWon < boundary) {
        boundary = level.priceWon;
      }
    }

    for (const prev of prevLevels) {
      if (prev.priceWon <= 0 || prev.qty <= 0) continue;
      let currQty: number | null = currByPrice.get(prev.priceWon) ?? null;
      if (currQty === null && boundary !== null) {
        if ((side === "ask" && prev.priceWon <= boundary) || (side === "bid" && prev.priceWon >= boundary)) {
          currQty = 0;
        }
      }
      if (currQty === null) continue;

      const matchedExec = execMap.get(prev.priceWon) ?? 0;
      const drop = Math.max(0, prev.qty - currQty);
      if (drop >= SPOOF_MIN_DROP_QTY) {
        const cancelled = Math.max(0, drop - matchedExec);
        const ratioBps = Math.floor((cancelled * BPS_SCALE) / drop);
        if (ratioBps >= SPOOF_MIN_CANCEL_RATIO_BPS) {
          out.push({
            recvMs,
            kind: "spoof_cancel",
            side,
            priceWon: prev.priceWon,
            cancelledOrAbsorbedQty: cancelled,
            displayedQty: prev.qty,
            executedQty: matchedExec,
            ratioBps,
          });
        }
      }

      if (currQty > 0 && matchedExec >= ICEBERG_MIN_EXEC_QTY && matchedExec * BPS_SCALE >= prev.qty * ICEBERG_MIN_RATIO_BPS) {
        const ratioBps = Math.floor((matchedExec * BPS_SCALE) / prev.qty);
        out.push({
          recvMs,
          kind: "iceberg_absorb",
          side,
          priceWon: prev.priceWon,
          cancelledOrAbsorbedQty: matchedExec,
          displayedQty: prev.qty,
          executedQty: matchedExec,
          ratioBps,
        });
      }
    }
  }

  private evictOfi(recvMs: number): void {
    const cutoff = recvMs - OFI_WINDOW_MS;
    while (this.ofiSamples.length > 0 && this.ofiSamples[0]!.recvMs <= cutoff) {
      const removed = this.ofiSamples.shift()!;
      this.ofiSum -= removed.delta;
      this.ofiAbsSum -= Math.abs(removed.delta);
    }
  }

  private evictTrades(recvMs: number): void {
    const recentCutoff = recvMs - OFI_WINDOW_MS;
    while (this.recentTrades.length > 0 && this.recentTrades[0]! <= recentCutoff) this.recentTrades.shift();
    const baselineCutoff = recvMs - TAPE_BASELINE_WINDOW_MS;
    while (this.baselineTrades.length > 0 && this.baselineTrades[0]! <= baselineCutoff) this.baselineTrades.shift();
  }

  private snapshotOfi(recvMs: number): OfiSnapshot {
    const buyPressurePct = this.ofiAbsSum === 0
      ? 50
      : Math.max(0, Math.min(100, Math.floor(((this.ofiSum + this.ofiAbsSum) * 100) / (2 * this.ofiAbsSum))));
    let tapeSpeedRatioBps = BPS_SCALE;
    if (this.baselineTrades.length > 0) {
      if (this.recentTrades.length === 0) {
        tapeSpeedRatioBps = 0;
      } else {
        const elapsed = this.firstTradeMs === null ? OFI_WINDOW_MS : recvMs - this.firstTradeMs;
        const span = Math.max(OFI_WINDOW_MS, Math.min(TAPE_BASELINE_WINDOW_MS, elapsed));
        tapeSpeedRatioBps = Math.floor((this.recentTrades.length * span * BPS_SCALE) / (this.baselineTrades.length * OFI_WINDOW_MS));
      }
    }
    return {
      recvMs,
      buyPressurePct,
      ofiQty: this.ofiSum,
      tapeSpeedRatioBps,
    };
  }
}
