import type { OfiSnapshot } from "../../api/generated/OfiSnapshot";

export interface MicroBookLevel {
  readonly priceWon: number;
  readonly qty: number;
}

const BPS_SCALE = 10_000;
const SINGLE_PRICE_MAX_LEVELS = 3;
const OFI_WINDOW_MS = 10_000;
const TAPE_BASELINE_WINDOW_MS = 60_000;

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
  private readonly ofiSamples: { recvMs: number; delta: number }[] = [];
  private ofiSum = 0;
  private ofiAbsSum = 0;
  private readonly recentTrades: number[] = [];
  private readonly baselineTrades: number[] = [];
  private firstTradeMs: number | null = null;

  reset(): void {
    this.prevAsks = [];
    this.prevBids = [];
    this.ofiSamples.length = 0;
    this.ofiSum = 0;
    this.ofiAbsSum = 0;
    this.recentTrades.length = 0;
    this.baselineTrades.length = 0;
    this.firstTradeMs = null;
  }

  onTrade(recvMs: number, priceWon: number, signedQty: number): void {
    if (priceWon <= 0 || signedQty === 0) return;
    if (this.firstTradeMs === null) this.firstTradeMs = recvMs;
    this.recentTrades.push(recvMs);
    this.baselineTrades.push(recvMs);
    this.evictTrades(recvMs);
  }

  onBook(recvMs: number, asks: readonly MicroBookLevel[], bids: readonly MicroBookLevel[]): OfiSnapshot {
    this.evictOfi(recvMs);
    this.evictTrades(recvMs);

    const validAsks = asks.filter((level) => level.priceWon > 0);
    const validBids = bids.filter((level) => level.priceWon > 0);
    const activeAskCount = validAsks.filter((level) => level.qty > 0).length;
    const activeBidCount = validBids.filter((level) => level.qty > 0).length;
    if (activeAskCount <= SINGLE_PRICE_MAX_LEVELS && activeBidCount <= SINGLE_PRICE_MAX_LEVELS) {
      this.prevAsks = [];
      this.prevBids = [];
      return this.snapshotOfi(recvMs);
    }

    if (this.prevAsks.length > 0 || this.prevBids.length > 0) {
      const delta = computeOfiDelta(this.prevAsks, this.prevBids, validAsks, validBids);
      if (delta !== null && delta !== 0) {
        this.ofiSamples.push({ recvMs, delta });
        this.ofiSum += delta;
        this.ofiAbsSum += Math.abs(delta);
      }
    }

    this.prevAsks = validAsks;
    this.prevBids = validBids;

    return this.snapshotOfi(recvMs);
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
