export type PaperOrderSide = "buy" | "sell";

export interface PaperOpenOrder {
  readonly id: number;
  readonly side: PaperOrderSide;
  readonly price: number;
  readonly quantity: number;
  readonly createdMs: number;
}

export interface PaperFill {
  readonly id: number;
  readonly side: PaperOrderSide;
  readonly price: number;
  readonly quantity: number;
  readonly value: number;
  readonly ms: number;
  readonly realizedPnl: number | null;
  readonly realizedPct: number | null;
  readonly fee: number;
  readonly immediate: boolean;
}

export interface PaperStatusNotice {
  readonly tone: "ok" | "warn" | "error" | "info";
  readonly text: string;
}

export interface PaperAccountSnapshot {
  readonly cash: number;
  readonly quantity: number;
  readonly avgPrice: number;
  readonly realizedPnl: number;
  readonly totalFees: number;
  readonly nextOrderId: number;
  readonly nextFillId: number;
  readonly openOrders: readonly PaperOpenOrder[];
  readonly fills: readonly PaperFill[];
}

export interface PaperMarketContext {
  readonly cursorMs: number;
  readonly bestAsk: number | null;
  readonly bestBid: number | null;
  readonly lastPrice: number | null;
}

export interface PaperMarketStep {
  readonly ms: number;
  readonly tradePrice: number | null;
  readonly bestAsk: number | null;
  readonly bestBid: number | null;
}

export interface PaperRewindUndo {
  readonly targetMs: number;
  readonly previousCursorMs: number;
  readonly previousState: PaperAccountSnapshot;
  readonly revertedFills: number;
  readonly revertedOrders: number;
}

export interface PaperSummary {
  readonly initialCash: number;
  readonly feeEnabled: boolean;
  readonly cash: number;
  readonly availableCash: number;
  readonly reservedBuyCash: number;
  readonly quantity: number;
  readonly sellableQuantity: number;
  readonly reservedSellQuantity: number;
  readonly avgPrice: number;
  readonly evaluationValue: number;
  readonly unrealizedPnl: number;
  readonly unrealizedPct: number;
  readonly realizedPnl: number;
  readonly totalEquity: number;
  readonly totalReturn: number;
  readonly totalReturnPct: number;
  readonly totalFees: number;
  readonly openOrders: readonly PaperOpenOrder[];
  readonly fills: readonly PaperFill[];
  readonly status: PaperStatusNotice;
  readonly lastRewindUndo: PaperRewindUndo | null;
}

export const DEFAULT_PAPER_INITIAL_CASH = 30_000_000;
export const PAPER_CASH_PRESETS_MAN = [1_000, 3_000, 5_000, 10_000] as const;
export const PAPER_AMOUNT_PRESETS_MAN = [100, 300, 500, 1_000] as const;
export const PAPER_FEE_RATE = 0.00015;
export const PAPER_SELL_TAX_RATE = 0.0015;

export function affordableMaxBuyQuantity(
  price: number,
  availableCash: number,
  feeEnabled: boolean,
): number {
  if (!(price > 0) || !(availableCash > 0)) return 0;
  const unitCost = feeEnabled ? price * (1 + PAPER_FEE_RATE) : price;
  let qty = Math.floor(availableCash / unitCost);
  if (feeEnabled) {
    while (qty > 0 && qty * price + Math.round(qty * price * PAPER_FEE_RATE) > availableCash) {
      qty -= 1;
    }
    while ((qty + 1) * price + Math.round((qty + 1) * price * PAPER_FEE_RATE) <= availableCash) {
      qty += 1;
    }
  }
  return Math.max(0, qty);
}

export function resolvePaperBuyQuantity(
  price: number,
  availableCash: number,
  feeEnabled: boolean,
  ratioPercent: number | null,
  fallbackQty: number,
): number {
  if (ratioPercent === null) return fallbackQty;
  const maxQty = affordableMaxBuyQuantity(price, availableCash, feeEnabled);
  if (maxQty <= 0) return 0;
  return ratioPercent >= 100 ? maxQty : Math.floor((maxQty * ratioPercent) / 100);
}

const MAX_SNAPSHOTS = 500;
const FILL_FLASH_DURATION_MS = 520;
const MINUS = "\u2212";

function formatWon(value: number): string {
  return Math.round(value).toLocaleString("ko-KR");
}

function formatSignedWon(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : MINUS}${Math.abs(rounded).toLocaleString("ko-KR")}`;
}

function cloneSnapshot(src: PaperAccountSnapshot): PaperAccountSnapshot {
  return {
    cash: src.cash,
    quantity: src.quantity,
    avgPrice: src.avgPrice,
    realizedPnl: src.realizedPnl,
    totalFees: src.totalFees,
    nextOrderId: src.nextOrderId,
    nextFillId: src.nextFillId,
    openOrders: src.openOrders.map((o) => ({ ...o })),
    fills: src.fills.map((f) => ({ ...f })),
  };
}

function initialAccountSnapshot(initialCash: number): PaperAccountSnapshot {
  return {
    cash: initialCash,
    quantity: 0,
    avgPrice: 0,
    realizedPnl: 0,
    totalFees: 0,
    nextOrderId: 1,
    nextFillId: 1,
    openOrders: [],
    fills: [],
  };
}

interface TimestampedSnapshot {
  readonly ms: number;
  readonly state: PaperAccountSnapshot;
}

export class ReplayPaperEngine {
  private readonly nowPerf: () => number;
  private readonly listeners = new Set<() => void>();

  private initialCash: number;
  private feeEnabled = false;
  private cash: number;
  private quantity = 0;
  private avgPrice = 0;
  private realizedPnl = 0;
  private totalFees = 0;
  private nextOrderId = 1;
  private nextFillId = 1;
  private openOrders: PaperOpenOrder[] = [];
  private fills: PaperFill[] = [];
  private snapshots: TimestampedSnapshot[] = [];
  private loopAnchorSnapshot: PaperAccountSnapshot | null = null;
  private lastRewindUndo: PaperRewindUndo | null = null;
  private readonly fillFlashes = new Map<number, number>();
  private status: PaperStatusNotice = {
    tone: "info",
    text: "좌측(매도)·우측(매수) 칸을 눌러 가상 주문을 등록하세요",
  };

  constructor(options?: { readonly initialCash?: number; readonly nowPerf?: () => number }) {
    this.initialCash = options?.initialCash ?? DEFAULT_PAPER_INITIAL_CASH;
    this.cash = this.initialCash;
    this.nowPerf = options?.nowPerf ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private currentSnapshot(): PaperAccountSnapshot {
    return cloneSnapshot({
      cash: this.cash,
      quantity: this.quantity,
      avgPrice: this.avgPrice,
      realizedPnl: this.realizedPnl,
      totalFees: this.totalFees,
      nextOrderId: this.nextOrderId,
      nextFillId: this.nextFillId,
      openOrders: this.openOrders,
      fills: this.fills,
    });
  }

  private restoreSnapshot(snap: PaperAccountSnapshot): void {
    const copy = cloneSnapshot(snap);
    this.cash = copy.cash;
    this.quantity = copy.quantity;
    this.avgPrice = copy.avgPrice;
    this.realizedPnl = copy.realizedPnl;
    this.totalFees = copy.totalFees;
    this.nextOrderId = copy.nextOrderId;
    this.nextFillId = copy.nextFillId;
    this.openOrders = [...copy.openOrders];
    this.fills = [...copy.fills];
  }

  private recordSnapshot(ms: number): void {
    while (this.snapshots.length > 0 && this.snapshots[this.snapshots.length - 1]!.ms > ms) {
      this.snapshots.pop();
    }
    this.snapshots.push({ ms, state: this.currentSnapshot() });
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.shift();
    }
  }

  getInitialCash(): number {
    return this.initialCash;
  }

  isFeeEnabled(): boolean {
    return this.feeEnabled;
  }

  getFills(): readonly PaperFill[] {
    return this.fills;
  }

  getOpenOrders(): readonly PaperOpenOrder[] {
    return this.openOrders;
  }

  getHolding(): { readonly quantity: number; readonly avgPrice: number } {
    return { quantity: this.quantity, avgPrice: this.avgPrice };
  }

  getReservedBuyCash(): number {
    let sum = 0;
    for (const o of this.openOrders) {
      if (o.side === "buy") sum += o.price * o.quantity;
    }
    return sum;
  }

  getReservedSellQuantity(): number {
    let sum = 0;
    for (const o of this.openOrders) {
      if (o.side === "sell") sum += o.quantity;
    }
    return sum;
  }

  getAvailableCash(): number {
    return Math.max(0, this.cash - this.getReservedBuyCash());
  }

  getSellableQuantity(): number {
    return Math.max(0, this.quantity - this.getReservedSellQuantity());
  }

  isPriceFillFlashing(price: number, perfNow = this.nowPerf()): boolean {
    const until = this.fillFlashes.get(price);
    if (until === undefined) return false;
    if (perfNow >= until) {
      this.fillFlashes.delete(price);
      return false;
    }
    return true;
  }

  getSummary(markPrice: number | null): PaperSummary {
    const evalPrice = markPrice !== null && markPrice > 0 ? markPrice : this.avgPrice;
    const evaluationValue = this.quantity > 0 ? this.quantity * evalPrice : 0;
    const costBasis = this.quantity > 0 ? this.quantity * this.avgPrice : 0;
    const unrealizedPnl = this.quantity > 0 ? evaluationValue - costBasis : 0;
    const unrealizedPct = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;
    const totalEquity = this.cash + evaluationValue;
    const totalReturn = totalEquity - this.initialCash;
    const totalReturnPct = this.initialCash > 0 ? (totalReturn / this.initialCash) * 100 : 0;
    const reservedBuyCash = this.getReservedBuyCash();
    const reservedSellQuantity = this.getReservedSellQuantity();

    return {
      initialCash: this.initialCash,
      feeEnabled: this.feeEnabled,
      cash: this.cash,
      availableCash: Math.max(0, this.cash - reservedBuyCash),
      reservedBuyCash,
      quantity: this.quantity,
      sellableQuantity: Math.max(0, this.quantity - reservedSellQuantity),
      reservedSellQuantity,
      avgPrice: this.avgPrice,
      evaluationValue,
      unrealizedPnl,
      unrealizedPct,
      realizedPnl: this.realizedPnl,
      totalEquity,
      totalReturn,
      totalReturnPct,
      totalFees: this.totalFees,
      openOrders: this.openOrders,
      fills: this.fills,
      status: this.status,
      lastRewindUndo: this.lastRewindUndo,
    };
  }

  setFeeEnabled(enabled: boolean): void {
    if (this.feeEnabled === enabled) return;
    this.feeEnabled = enabled;
    this.status = {
      tone: "info",
      text: enabled
        ? "수수료 0.015% + 매도 거래세 0.15%가 다음 체결부터 반영됩니다"
        : "수수료·거래세 미반영 (순수 가격 손익)",
    };
    this.emit();
  }

  reset(nextInitialCash?: number, cursorMs?: number): void {
    if (nextInitialCash !== undefined && Number.isFinite(nextInitialCash) && nextInitialCash > 0) {
      this.initialCash = Math.round(nextInitialCash);
    }
    this.restoreSnapshot(initialAccountSnapshot(this.initialCash));
    this.snapshots = [];
    this.loopAnchorSnapshot = null;
    this.lastRewindUndo = null;
    this.fillFlashes.clear();
    if (cursorMs !== undefined) {
      this.recordSnapshot(cursorMs);
    }
    this.status = {
      tone: "info",
      text: `가상 계좌가 ${formatWon(this.initialCash)}원으로 초기화되었습니다`,
    };
    this.emit();
  }

  seedAnchor(cursorMs: number): void {
    if (this.snapshots.length === 0) {
      this.recordSnapshot(cursorMs);
    }
  }

  setLoopAnchor(): void {
    this.loopAnchorSnapshot = this.currentSnapshot();
  }

  clearLoopAnchor(): void {
    this.loopAnchorSnapshot = null;
  }

  clearRewindUndo(): void {
    if (this.lastRewindUndo === null) return;
    this.lastRewindUndo = null;
    this.emit();
  }

  private executeFill(
    side: PaperOrderSide,
    price: number,
    requestedQty: number,
    ms: number,
    immediate: boolean,
  ): PaperFill | null {
    if (!(price > 0) || !(requestedQty > 0)) return null;
    let qty = Math.floor(requestedQty);
    let realizedPnl: number | null = null;
    let realizedPct: number | null = null;

    if (side === "buy") {
      const value = price * qty;
      const fee = this.feeEnabled ? Math.round(value * PAPER_FEE_RATE) : 0;
      const totalCost = this.avgPrice * this.quantity + value + fee;
      this.quantity += qty;
      this.avgPrice = totalCost / this.quantity;
      this.cash -= value + fee;
      this.totalFees += fee;
      const fill: PaperFill = {
        id: this.nextFillId++,
        side,
        price,
        quantity: qty,
        value,
        ms,
        realizedPnl: null,
        realizedPct: null,
        fee,
        immediate,
      };
      this.fills = [fill, ...this.fills];
      this.fillFlashes.set(price, this.nowPerf() + FILL_FLASH_DURATION_MS);
      return fill;
    }

    qty = Math.min(qty, this.quantity);
    if (qty <= 0) return null;
    const value = price * qty;
    const fee = this.feeEnabled ? Math.round(value * (PAPER_FEE_RATE + PAPER_SELL_TAX_RATE)) : 0;
    const costBasis = this.avgPrice * qty;
    const proceeds = value - fee;
    realizedPnl = proceeds - costBasis;
    realizedPct = costBasis > 0 ? (realizedPnl / costBasis) * 100 : 0;
    this.realizedPnl += realizedPnl;
    this.cash += proceeds;
    this.quantity -= qty;
    this.totalFees += fee;
    if (this.quantity === 0) this.avgPrice = 0;

    const fill: PaperFill = {
      id: this.nextFillId++,
      side,
      price,
      quantity: qty,
      value,
      ms,
      realizedPnl,
      realizedPct,
      fee,
      immediate,
    };
    this.fills = [fill, ...this.fills];
    this.fillFlashes.set(price, this.nowPerf() + FILL_FLASH_DURATION_MS);
    return fill;
  }

  placeOrder(side: PaperOrderSide, price: number, quantity: number, context: PaperMarketContext): boolean {
    const wholeQty = Math.floor(quantity);
    if (!(wholeQty > 0)) {
      this.status = { tone: "warn", text: "주문 수량을 1주 이상 입력하세요" };
      this.emit();
      return false;
    }
    if (!(price > 0)) return false;

    this.lastRewindUndo = null;
    const bestAsk = context.bestAsk;
    const bestBid = context.bestBid;

    if (side === "buy") {
      const marketable = bestAsk !== null && price >= bestAsk;
      const execPrice = marketable ? bestAsk : price;
      const fee = this.feeEnabled ? Math.round(execPrice * wholeQty * PAPER_FEE_RATE) : 0;
      const needed = execPrice * wholeQty + (marketable ? fee : 0);
      const avail = this.getAvailableCash();
      if (needed > avail) {
        this.status = { tone: "error", text: `주문가능 현금(${formatWon(avail)}원)을 초과합니다` };
        this.emit();
        return false;
      }
      if (marketable) {
        this.executeFill("buy", execPrice, wholeQty, context.cursorMs, true);
        this.recordSnapshot(context.cursorMs);
        this.status = { tone: "ok", text: `[즉시 매수 체결] ${formatWon(execPrice)}원 × ${formatWon(wholeQty)}주` };
      } else {
        this.openOrders = [
          ...this.openOrders,
          { id: this.nextOrderId++, side: "buy", price, quantity: wholeQty, createdMs: context.cursorMs },
        ];
        this.recordSnapshot(context.cursorMs);
        this.status = { tone: "info", text: `[매수 주문 대기] ${formatWon(price)}원 × ${formatWon(wholeQty)}주` };
      }
      this.emit();
      return true;
    }

    const sellable = this.getSellableQuantity();
    if (wholeQty > sellable) {
      this.status = { tone: "error", text: `매도 가능 수량(${formatWon(sellable)}주)을 초과합니다` };
      this.emit();
      return false;
    }

    const marketable = bestBid !== null && price <= bestBid;
    if (marketable) {
      const fill = this.executeFill("sell", bestBid, wholeQty, context.cursorMs, true);
      this.recordSnapshot(context.cursorMs);
      const pnlText = fill && fill.realizedPnl !== null ? ` (${formatSignedWon(fill.realizedPnl)}원)` : "";
      this.status = { tone: "ok", text: `[즉시 매도 체결] ${formatWon(bestBid)}원 × ${formatWon(wholeQty)}주${pnlText}` };
    } else {
      this.openOrders = [
        ...this.openOrders,
        { id: this.nextOrderId++, side: "sell", price, quantity: wholeQty, createdMs: context.cursorMs },
      ];
      this.recordSnapshot(context.cursorMs);
      this.status = { tone: "info", text: `[매도 주문 대기] ${formatWon(price)}원 × ${formatWon(wholeQty)}주` };
    }
    this.emit();
    return true;
  }

  modifyOrdersAtPrice(
    side: PaperOrderSide,
    fromPrice: number,
    toPrice: number,
    context: PaperMarketContext,
  ): boolean {
    if (fromPrice === toPrice || !(toPrice > 0)) return false;
    const targets = this.openOrders.filter((o) => o.side === side && o.price === fromPrice);
    if (targets.length === 0) return false;
    const totalQty = targets.reduce((sum, o) => sum + o.quantity, 0);

    if (side === "buy") {
      const marketable = context.bestAsk !== null && toPrice >= context.bestAsk;
      const targetPrice = marketable ? context.bestAsk! : toPrice;
      const added = (targetPrice - fromPrice) * totalQty;
      if (added > this.getAvailableCash()) {
        this.status = { tone: "error", text: `정정 증액(${formatWon(added)}원)이 주문가능 현금을 초과합니다` };
        this.emit();
        return false;
      }
    }

    this.lastRewindUndo = null;
    this.openOrders = this.openOrders.filter((o) => !(o.side === side && o.price === fromPrice));

    if (side === "buy" && context.bestAsk !== null && toPrice >= context.bestAsk) {
      this.executeFill("buy", context.bestAsk, totalQty, context.cursorMs, true);
      this.status = { tone: "ok", text: `[정정 즉시 체결] 매수 ${formatWon(context.bestAsk)}원 × ${formatWon(totalQty)}주` };
    } else if (side === "sell" && context.bestBid !== null && toPrice <= context.bestBid) {
      const fill = this.executeFill("sell", context.bestBid, totalQty, context.cursorMs, true);
      const pnlText = fill && fill.realizedPnl !== null ? ` (${formatSignedWon(fill.realizedPnl)}원)` : "";
      this.status = { tone: "ok", text: `[정정 즉시 체결] 매도 ${formatWon(context.bestBid)}원 × ${formatWon(totalQty)}주${pnlText}` };
    } else {
      const moved = targets.map((o) => ({ ...o, price: toPrice }));
      this.openOrders = [...this.openOrders, ...moved];
      this.status = {
        tone: "info",
        text: `[주문 정정] ${side === "buy" ? "매수" : "매도"} ${formatWon(fromPrice)} → ${formatWon(toPrice)}원 (${formatWon(totalQty)}주)`,
      };
    }

    this.recordSnapshot(context.cursorMs);
    this.emit();
    return true;
  }

  cancelOrderById(id: number, cursorMs: number): boolean {
    const idx = this.openOrders.findIndex((o) => o.id === id);
    if (idx < 0) return false;
    const removed = this.openOrders[idx]!;
    this.openOrders = this.openOrders.filter((o) => o.id !== id);
    this.lastRewindUndo = null;
    this.recordSnapshot(cursorMs);
    this.status = {
      tone: "warn",
      text: `[주문 취소] ${removed.side === "buy" ? "매수" : "매도"} ${formatWon(removed.price)}원 × ${formatWon(removed.quantity)}주`,
    };
    this.emit();
    return true;
  }

  cancelOrdersAtPrice(side: PaperOrderSide, price: number, cursorMs: number): boolean {
    const matching = this.openOrders.filter((o) => o.side === side && o.price === price);
    if (matching.length === 0) return false;
    this.openOrders = this.openOrders.filter((o) => !(o.side === side && o.price === price));
    this.lastRewindUndo = null;
    this.recordSnapshot(cursorMs);
    this.status = {
      tone: "warn",
      text: `[주문 취소] ${side === "buy" ? "매수" : "매도"} ${formatWon(price)}원 ${matching.length}건 취소됨`,
    };
    this.emit();
    return true;
  }

  cancelOrdersBySide(side: PaperOrderSide, cursorMs: number): boolean {
    const count = this.openOrders.filter((o) => o.side === side).length;
    if (count === 0) return false;
    this.openOrders = this.openOrders.filter((o) => o.side !== side);
    this.lastRewindUndo = null;
    this.recordSnapshot(cursorMs);
    this.status = {
      tone: "warn",
      text: `[일괄 취소] ${side === "buy" ? "매수" : "매도"} 미체결 ${count}건 취소됨`,
    };
    this.emit();
    return true;
  }

  flattenPosition(context: PaperMarketContext): boolean {
    if (this.quantity <= 0) return false;
    const execPrice = context.bestBid ?? context.lastPrice;
    if (execPrice === null || !(execPrice > 0)) {
      this.status = { tone: "warn", text: "청산할 현재 호가가 없습니다" };
      this.emit();
      return false;
    }
    this.lastRewindUndo = null;
    this.openOrders = this.openOrders.filter((o) => o.side !== "sell");
    const qty = this.quantity;
    const fill = this.executeFill("sell", execPrice, qty, context.cursorMs, true);
    this.recordSnapshot(context.cursorMs);
    const pnlText = fill && fill.realizedPnl !== null ? ` (${formatSignedWon(fill.realizedPnl)}원)` : "";
    this.status = { tone: "ok", text: `[시장가 청산] ${formatWon(execPrice)}원 × ${formatWon(qty)}주${pnlText}` };
    this.emit();
    return true;
  }

  onMarketStep(step: PaperMarketStep): boolean {
    if (this.openOrders.length === 0) return false;
    const remaining: PaperOpenOrder[] = [];
    let filledAny = false;

    for (const order of this.openOrders) {
      const buyHit = order.side === "buy" && (
        (step.tradePrice !== null && step.tradePrice <= order.price)
        || (step.bestAsk !== null && step.bestAsk <= order.price)
      );
      const sellHit = order.side === "sell" && (
        (step.tradePrice !== null && step.tradePrice >= order.price)
        || (step.bestBid !== null && step.bestBid >= order.price)
      );

      if (buyHit || sellHit) {
        const fill = this.executeFill(order.side, order.price, order.quantity, step.ms, false);
        if (fill) {
          filledAny = true;
          const extra = fill.realizedPnl !== null ? ` · 손익 ${formatSignedWon(fill.realizedPnl)}원` : "";
          this.status = {
            tone: "ok",
            text: `[자동 체결] ${order.side === "buy" ? "매수" : "매도"} ${formatWon(order.price)}원 × ${formatWon(order.quantity)}주${extra}`,
          };
        }
      } else {
        remaining.push(order);
      }
    }

    if (!filledAny) return false;
    this.openOrders = remaining;
    this.lastRewindUndo = null;
    this.recordSnapshot(step.ms);
    this.emit();
    return true;
  }

  onRewind(targetMs: number, previousCursorMs: number, fromLoop: boolean): PaperRewindUndo | null {
    if (fromLoop && this.loopAnchorSnapshot !== null) {
      this.restoreSnapshot(this.loopAnchorSnapshot);
      this.lastRewindUndo = null;
      this.status = { tone: "info", text: "A-B 루프 반복 — 루프 시작 시점 포지션으로 복원되었습니다" };
      this.emit();
      return null;
    }

    const previousState = this.currentSnapshot();
    const prevFills = this.fills.length;
    const prevOrders = this.openOrders.length;

    let best: TimestampedSnapshot | null = null;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i]!.ms <= targetMs) {
        best = this.snapshots[i]!;
        break;
      }
    }

    if (best !== null) {
      this.restoreSnapshot(best.state);
    } else {
      this.restoreSnapshot(initialAccountSnapshot(this.initialCash));
    }

    const revertedFills = Math.max(0, prevFills - this.fills.length);
    const revertedOrders = Math.abs(prevOrders - this.openOrders.length);
    if (revertedFills === 0 && revertedOrders === 0) {
      return null;
    }

    const undo: PaperRewindUndo = {
      targetMs,
      previousCursorMs,
      previousState,
      revertedFills,
      revertedOrders,
    };
    this.lastRewindUndo = undo;
    this.status = {
      tone: "info",
      text: "과거 시점으로 되감아 이후 가상 주문·체결 상태를 복원했습니다",
    };
    this.emit();
    return undo;
  }

  undoRewind(): PaperRewindUndo | null {
    const undo = this.lastRewindUndo;
    if (undo === null) return null;
    this.restoreSnapshot(undo.previousState);
    this.lastRewindUndo = null;
    this.status = { tone: "info", text: "되감기 이전 가상 포지션으로 복구했습니다" };
    this.emit();
    return undo;
  }
}
