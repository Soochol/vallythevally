import type { BookReplayMeta } from "../../api/generated/BookReplayMeta";
import type { BookReplayMinuteCheckpoint } from "../../api/generated/BookReplayMinuteCheckpoint";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { bookReplaySpanUrl } from "../../api/bookReplay";
import {
  EVENT_KIND_BOOK,
  EVENT_KIND_PROGRAM,
  EVENT_KIND_TRADE,
  firstRowAtOrAfter,
  lastRowAtOrBefore,
  type OpenedHogaSpan,
} from "./hogaDecode";
import {
  isSinglePriceBook,
  type DeltaMode,
  type ReplayBookLevel,
  type ReplayLadderLevel,
  type ReplayLadderSnapshot,
  type ReplaySession,
  type ReplayTrade,
  type ReplayTradeSummary,
  WHALE_VALUE_WON,
  computeLadderSnapshot,
  filterRecentTrades,
  frameIndexAt,
  stepTickSec,
} from "./replayModel";
import { HogaSpanLoader, type SpanBufferFetcher } from "./spanLoader";

export const TIME_REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 20] as const;
export type TimeReplaySpeed = (typeof TIME_REPLAY_SPEEDS)[number];

export const TICK_REPLAY_RATES = [1, 2, 5, 15, 30, 60] as const;
export type TickReplayRate = (typeof TICK_REPLAY_RATES)[number];

export type TickEventFilter = "all" | "trade" | "book";

export type PlaybackMode =
  | { readonly kind: "time"; readonly speed: TimeReplaySpeed; readonly skipIdleMs: number | null }
  | { readonly kind: "tick"; readonly rateHz: TickReplayRate; readonly filter: TickEventFilter };

export interface ReplayLoopMs {
  readonly aMs: number;
  readonly bMs: number;
}

export interface FormingBar {
  readonly minute: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface CellFlash {
  readonly dir: 1 | -1;
  readonly untilMs: number;
}

export interface ReplayBookState {
  readonly asks: readonly ReplayBookLevel[];
  readonly bids: readonly ReplayBookLevel[];
  readonly totalAsk: number;
  readonly totalBid: number;
}

export interface EngineTickTrade extends ReplayTrade {
  readonly recvMs: number;
  readonly freshUntilMs: number;
}

export interface ReplayEngineFrame {
  readonly cursorMs: number;
  readonly deltaMs: number;
  readonly playing: boolean;
  readonly buffering: boolean;
  readonly resolution: "tick" | "minute_only";
  readonly price: number | null;
  readonly dayOpen: number | null;
  readonly dayHigh: number | null;
  readonly dayLow: number | null;
  readonly cumVol: number;
  readonly cumVal: number;
  readonly vwap: number | null;
  readonly strength: number;
  readonly programNetQty: number | null;
  readonly programNetAmtMillion: number | null;
  readonly inGap: boolean;
  readonly singlePrice: boolean;
  readonly formingBar: FormingBar | null;
  readonly ladder: ReplayLadderSnapshot;
  readonly cellFlashes: ReadonlyMap<string, CellFlash>;
  readonly hitRow: { readonly price: number; readonly side: "buy" | "sell"; readonly untilMs: number } | null;
  readonly tradeSummary: ReplayTradeSummary;
  readonly recentTrades: readonly EngineTickTrade[];
  readonly skipNotice: { readonly skippedMs: number; readonly untilMs: number } | null;
  readonly loadedSpans: readonly number[];
}

export interface ReplayEngineControlState {
  readonly playing: boolean;
  readonly buffering: boolean;
  readonly mode: PlaybackMode;
  readonly activeSecond: number;
  readonly loadedSpanCount: number;
}

export interface ReplayMarketStepEvent {
  readonly ms: number;
  readonly tradePrice: number | null;
  readonly bestAsk: number | null;
  readonly bestBid: number | null;
}

export interface ReplaySeekEvent {
  readonly previousMs: number;
  readonly targetMs: number;
  readonly fromLoop: boolean;
}

const MS_PER_MINUTE = 60_000;
const SPAN_MINUTES = 5;
const SPAN_MS = SPAN_MINUTES * MS_PER_MINUTE;
const PREFETCH_OFFSETS = [0, 1, 2, -1] as const;
const MAX_RECENT_TRADES = 60;
const FLASH_DURATION_MS = 240;
const HIT_DURATION_MS = 220;
const SKIP_NOTICE_DURATION_MS = 1600;
const MAX_FRAME_DT_MS = 100;

const EMPTY_BOOK: ReplayBookState = { asks: [], bids: [], totalAsk: 0, totalBid: 0 };

function extractBookRow(span: OpenedHogaSpan, row: number): ReplayBookState {
  const book = span.streams.book;
  if (!book || row < 0 || row >= book.rows) return EMPTY_BOOK;
  const cols = book.columns;
  const asks: ReplayBookLevel[] = [];
  const bids: ReplayBookLevel[] = [];
  for (let level = 1; level <= 10; level++) {
    const askPx = cols[`ask_px${level}`]?.[row] ?? 0;
    if (askPx > 0) {
      asks.push({ price: askPx, quantity: Math.max(0, cols[`ask_qty${level}`]?.[row] ?? 0) });
    }
    const bidPx = cols[`bid_px${level}`]?.[row] ?? 0;
    if (bidPx > 0) {
      bids.push({ price: bidPx, quantity: Math.max(0, cols[`bid_qty${level}`]?.[row] ?? 0) });
    }
  }
  return {
    asks,
    bids,
    totalAsk: Math.max(0, cols.ask_total?.[row] ?? 0),
    totalBid: Math.max(0, cols.bid_total?.[row] ?? 0),
  };
}

function extractTradeRow(span: OpenedHogaSpan, spanStart: number, row: number, freshUntilMs: number): EngineTickTrade | null {
  const trades = span.streams.trades;
  if (!trades || row < 0 || row >= trades.rows) return null;
  const cols = trades.columns;
  const recvMs = cols.recv_ms?.[row] ?? 0;
  const secondOfDay = cols.t_s?.[row] ?? Math.floor(recvMs / 1000);
  const price = Math.abs(cols.price?.[row] ?? 0);
  const signedQty = cols.qty?.[row] ?? 0;
  const quantity = Math.abs(signedQty);
  if (price <= 0 || quantity <= 0) return null;
  const value = price * quantity;
  return {
    key: `${spanStart}-${row}`,
    recvMs,
    secondOfDay,
    minute: Math.floor(recvMs / MS_PER_MINUTE),
    price,
    quantity,
    value,
    side: signedQty > 0 ? "buy" : signedQty < 0 ? "sell" : "none",
    whale: value >= WHALE_VALUE_WON,
    freshUntilMs,
  };
}

function extractProgramRow(span: OpenedHogaSpan, row: number): { netQty: number; netAmtMillion: number } | null {
  const program = span.streams.program;
  if (!program || row < 0 || row >= program.rows) return null;
  const cols = program.columns;
  const buyQty = cols.buy_qty?.[row] ?? 0;
  const sellQty = cols.sell_qty?.[row] ?? 0;
  const buyAmt = cols.buy_amt?.[row] ?? 0;
  const sellAmt = cols.sell_amt?.[row] ?? 0;
  return { netQty: buyQty - sellQty, netAmtMillion: buyAmt - sellAmt };
}

function buildLadderFromBooks(
  currentBook: ReplayBookState,
  refBook: ReplayBookState | null,
  deltaMode: DeltaMode,
  inGap: boolean,
  singlePrice: boolean,
  price: number | null,
  dayOpen: number | null,
  dayHigh: number | null,
  dayLow: number | null,
  previousClose: number | null,
  tickStepOf: (price: number) => number,
  lastHitSide: "buy" | "sell" | null,
): ReplayLadderSnapshot {
  if (inGap || (currentBook.asks.length === 0 && currentBook.bids.length === 0)) {
    const emptyRows: ReplayLadderLevel[] = Array.from({ length: 20 }, (_, i) => ({
      side: i < 10 ? "ask" : "bid",
      price: null,
      quantity: 0,
      delta: 0,
      ratio: 0,
      rate: null,
      wall: false,
      current: false,
      lastHit: null,
      tags: [],
      dimmed: true,
    }));
    return {
      rows: emptyRows,
      totalAsk: 0,
      totalBid: 0,
      totalAskDelta: 0,
      totalBidDelta: 0,
      askPct: 50,
      bidPct: 50,
      obi: 0,
      spreadTicks: null,
      spreadWon: null,
      singlePrice: false,
      inGap,
    };
  }

  const refAsks = new Map(refBook?.asks.map((l) => [l.price, l.quantity]) ?? []);
  const refBids = new Map(refBook?.bids.map((l) => [l.price, l.quantity]) ?? []);
  const allQty = [...currentBook.asks, ...currentBook.bids].map((l) => l.quantity);
  const maxQty = Math.max(1, ...allQty);
  const avgQty = allQty.length >= 4 ? allQty.reduce((a, b) => a + b, 0) / allQty.length : Infinity;
  const wallThreshold = avgQty * 2.5;

  const rows: ReplayLadderLevel[] = [];
  for (let i = 0; i < 20; i++) {
    const side: "ask" | "bid" = i < 10 ? "ask" : "bid";
    const levelIdx = side === "ask" ? 9 - i : i - 10;
    const level = side === "ask" ? currentBook.asks[levelIdx] : currentBook.bids[levelIdx];
    if (!level) {
      rows.push({
        side,
        price: null,
        quantity: 0,
        delta: 0,
        ratio: 0,
        rate: null,
        wall: false,
        current: false,
        lastHit: null,
        tags: [],
        dimmed: singlePrice,
      });
      continue;
    }

    const prevQty = (side === "ask" ? refAsks : refBids).get(level.price);
    const delta = deltaMode === "off" || prevQty === undefined ? 0 : level.quantity - prevQty;
    const rate = previousClose !== null && previousClose > 0
      ? ((level.price - previousClose) / previousClose) * 100
      : null;

    const tags: ("open" | "high" | "low")[] = [];
    if (dayOpen === level.price) tags.push("open");
    if (dayHigh === level.price) tags.push("high");
    if (dayLow === level.price) tags.push("low");

    const current = !singlePrice && price === level.price;
    const lastHit = current ? lastHitSide : null;

    rows.push({
      side,
      price: level.price,
      quantity: level.quantity,
      delta,
      ratio: Math.min(1, level.quantity / maxQty),
      rate,
      wall: !singlePrice && level.quantity >= wallThreshold,
      current,
      lastHit,
      tags,
      dimmed: false,
    });
  }

  const totalAsk = currentBook.totalAsk;
  const totalBid = currentBook.totalBid;
  const totalAskDelta = refBook && deltaMode !== "off" ? totalAsk - refBook.totalAsk : 0;
  const totalBidDelta = refBook && deltaMode !== "off" ? totalBid - refBook.totalBid : 0;
  const sum = totalAsk + totalBid;
  const askPct = sum > 0 ? Math.round((totalAsk / sum) * 100) : 50;
  const bidPct = sum > 0 ? 100 - askPct : 50;
  const obi = sum > 0 ? (totalBid - totalAsk) / sum : 0;

  let spreadWon: number | null = null;
  let spreadTicks: number | null = null;
  if (currentBook.asks[0] && currentBook.bids[0]) {
    spreadWon = currentBook.asks[0].price - currentBook.bids[0].price;
    const step = tickStepOf(currentBook.bids[0].price);
    spreadTicks = step > 0 ? Math.max(0, Math.round(spreadWon / step)) : null;
  }

  return {
    rows,
    totalAsk,
    totalBid,
    totalAskDelta,
    totalBidDelta,
    askPct,
    bidPct,
    obi,
    spreadTicks,
    spreadWon,
    singlePrice,
    inGap: false,
  };
}

function spanMatchesFilter(kind: number, filter: TickEventFilter): boolean {
  if (filter === "all") return kind === EVENT_KIND_BOOK || kind === EVENT_KIND_TRADE;
  if (filter === "trade") return kind === EVENT_KIND_TRADE;
  return kind === EVENT_KIND_BOOK;
}

export interface ReplayEngineOptions {
  readonly code: SymbolCode;
  readonly session: ReplaySession;
  readonly meta: BookReplayMeta | null;
  readonly spanFetcher?: SpanBufferFetcher;
  readonly nowPerf?: () => number;
}

export class ReplayEngine {
  private readonly code: SymbolCode;
  private readonly session: ReplaySession;
  private readonly meta: BookReplayMeta | null;
  private readonly resolution: "tick" | "minute_only";
  private readonly loader: HogaSpanLoader;
  private readonly nowPerf: () => number;
  private readonly checkpointByMin = new Map<number, BookReplayMinuteCheckpoint>();
  private readonly availableSpans: readonly number[];
  private readonly frameListeners = new Set<(frame: ReplayEngineFrame) => void>();
  private readonly controlListeners = new Set<(state: ReplayEngineControlState) => void>();
  private readonly marketStepListeners = new Set<(step: ReplayMarketStepEvent) => void>();
  private readonly seekListeners = new Set<(event: ReplaySeekEvent) => void>();

  private mode: PlaybackMode = { kind: "time", speed: 1, skipIdleMs: null };
  private deltaMode: DeltaMode = "tick";
  private tapeMinWon = 0;
  private loop: ReplayLoopMs | null = null;

  private playing = false;
  private buffering = false;
  private cursorMs: number;
  private deltaMs = 0;
  private lastEventMs: number;
  private tickBudget = 0;
  private activeSpanStart = -1;
  private eventCursor = -1;
  private activeSecond = -1;

  private currentBook: ReplayBookState = EMPTY_BOOK;
  private prevBook: ReplayBookState | null = null;
  private minuteStartBook: ReplayBookState | null = null;
  private lastBookMinute = -1;
  private price: number | null = null;
  private dayOpen: number | null = null;
  private dayHigh: number | null = null;
  private dayLow: number | null = null;
  private cumVol = 0;
  private cumVal = 0;
  private cumBuyQty = 0;
  private cumSellQty = 0;
  private programNetQty: number | null = null;
  private programNetAmtMillion: number | null = null;
  private formingBar: FormingBar | null = null;
  private recentTrades: EngineTickTrade[] = [];
  private oneMinDeque: EngineTickTrade[] = [];
  private oneMinNetQty = 0;
  private whaleBuy = 0;
  private whaleSell = 0;
  private readonly cellFlashes = new Map<string, CellFlash>();
  private hitRow: { readonly price: number; readonly side: "buy" | "sell"; readonly untilMs: number } | null = null;
  private skipNotice: { readonly skippedMs: number; readonly untilMs: number } | null = null;

  private rafId = 0;
  private lastRafMs = 0;
  private disposed = false;
  private cachedFrame: ReplayEngineFrame;

  constructor(options: ReplayEngineOptions) {
    this.code = options.code;
    this.session = options.session;
    this.meta = options.meta;
    this.nowPerf = options.nowPerf ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.resolution = options.meta?.resolution === "tick" && options.meta.spans.length > 0 ? "tick" : "minute_only";
    this.availableSpans = options.meta
      ? options.meta.spans
          .filter((s) => s.bookRows > 0 || s.tradeRows > 0 || s.programRows > 0)
          .map((s) => s.startMinute)
          .sort((a, b) => a - b)
      : [];
    if (options.meta) {
      for (const ck of options.meta.minutes) {
        this.checkpointByMin.set(ck.minute, ck);
      }
    }
    this.loader = new HogaSpanLoader({ fetcher: options.spanFetcher });
    this.loader.onUpdate = (key) => this.handleSpanLoaded(key);

    const firstStartMs = this.initialCursorMs();
    this.cursorMs = firstStartMs;
    this.lastEventMs = firstStartMs;
    this.cachedFrame = this.buildSnapshot(this.nowPerf());
    this.seekMs(firstStartMs);
  }

  private initialCursorMs(): number {
    if (this.resolution === "tick" && this.availableSpans.length > 0) {
      const firstMinute = this.meta?.minutes[0]?.minute ?? this.availableSpans[0]!;
      return firstMinute * MS_PER_MINUTE;
    }
    const firstFrameSec = this.session.frames[0]?.t ?? this.session.sessionStartSec;
    return firstFrameSec * 1000;
  }

  getResolution(): "tick" | "minute_only" {
    return this.resolution;
  }

  getFrame(): ReplayEngineFrame {
    return this.cachedFrame;
  }

  getControlState(): ReplayEngineControlState {
    return {
      playing: this.playing,
      buffering: this.buffering,
      mode: this.mode,
      activeSecond: Math.floor(this.cursorMs / 1000),
      loadedSpanCount: this.loader.cachedKeys().length,
    };
  }

  subscribeFrame(listener: (frame: ReplayEngineFrame) => void): () => void {
    this.frameListeners.add(listener);
    listener(this.cachedFrame);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  subscribeControl(listener: (state: ReplayEngineControlState) => void): () => void {
    this.controlListeners.add(listener);
    listener(this.getControlState());
    return () => {
      this.controlListeners.delete(listener);
    };
  }

  subscribeMarketStep(listener: (step: ReplayMarketStepEvent) => void): () => void {
    this.marketStepListeners.add(listener);
    return () => {
      this.marketStepListeners.delete(listener);
    };
  }

  subscribeSeek(listener: (event: ReplaySeekEvent) => void): () => void {
    this.seekListeners.add(listener);
    return () => {
      this.seekListeners.delete(listener);
    };
  }

  setMode(next: PlaybackMode): void {
    this.mode = next;
    this.tickBudget = 0;
    this.emitControl();
    this.emitFrame();
  }

  setDeltaMode(mode: DeltaMode): void {
    if (this.deltaMode === mode) return;
    this.deltaMode = mode;
    this.emitFrame();
  }

  setTapeMinWon(minWon: number): void {
    if (this.tapeMinWon === minWon) return;
    this.tapeMinWon = minWon;
    this.emitFrame();
  }

  setLoop(loop: ReplayLoopMs | null): void {
    this.loop = loop;
  }

  setPlaying(next: boolean): void {
    if (this.playing === next) return;
    if (next && this.cursorMs >= this.session.sessionEndSec * 1000 - 100) {
      this.seekMs(this.initialCursorMs());
    }
    this.playing = next;
    this.tickBudget = 0;
    this.lastRafMs = 0;
    if (next) {
      this.startLoop();
    } else {
      this.stopLoop();
    }
    this.emitControl();
    this.emitFrame();
  }

  togglePlay(): void {
    this.setPlaying(!this.playing);
  }

  seekSec(sec: number): void {
    this.seekMs(sec * 1000);
  }

  seekMs(targetMs: number, options?: { readonly fromLoop?: boolean }): void {
    const startMs = this.session.sessionStartSec * 1000;
    const endMs = Math.max(startMs, this.session.sessionEndSec * 1000 - 100);
    const clamped = Math.max(startMs, Math.min(endMs, targetMs));
    const previousMs = this.cursorMs;
    const fromLoop = options?.fromLoop === true;
    this.cursorMs = clamped;
    this.tickBudget = 0;
    this.cellFlashes.clear();
    this.hitRow = null;

    if (this.resolution === "minute_only") {
      this.buffering = false;
      this.activeSecond = Math.floor(clamped / 1000);
      if (clamped < previousMs) {
        this.emitSeek({ previousMs, targetMs: clamped, fromLoop });
      } else if (clamped > previousMs) {
        this.scanMinuteOnlyForward(previousMs, clamped);
      }
      this.emitFrame();
      this.emitControl();
      return;
    }

    const spanStart = this.spanStartOfMs(clamped);
    this.ensurePrefetchWindow(spanStart);
    const span = this.loader.get(this.spanKey(spanStart));
    if (!span) {
      if (this.loader.hasFailed(this.spanKey(spanStart)) || !this.hasSpanOnServer(spanStart)) {
        this.buffering = false;
        this.activeSpanStart = spanStart;
        this.eventCursor = -1;
        this.restoreEmptyAt(clamped);
      } else {
        this.buffering = true;
        this.activeSpanStart = spanStart;
      }
      if (clamped < previousMs) {
        this.emitSeek({ previousMs, targetMs: clamped, fromLoop });
      }
      this.emitControl();
      this.emitFrame();
      return;
    }

    this.buffering = false;
    if (clamped < previousMs) {
      this.reconstructFromSpan(spanStart, span, clamped);
      this.emitSeek({ previousMs, targetMs: clamped, fromLoop });
    } else if (clamped > previousMs) {
      this.scanTickForward(previousMs, clamped);
      this.reconstructFromSpan(spanStart, span, clamped);
    } else {
      this.reconstructFromSpan(spanStart, span, clamped);
    }
    this.emitControl();
    this.emitFrame();
  }

  stepSec(deltaSec: number): void {
    this.seekMs(this.cursorMs + deltaSec * 1000);
  }

  stepTick(dir: -1 | 1): void {
    if (this.playing) this.setPlaying(false);
    if (this.resolution === "minute_only") {
      const nextSec = stepTickSec(this.session.frames, this.cursorMs / 1000, dir);
      this.seekMs(nextSec * 1000);
      return;
    }

    const filter: TickEventFilter = this.mode.kind === "tick" ? this.mode.filter : "all";
    const perfNow = this.nowPerf();

    if (dir > 0) {
      this.advanceOneMatchingEvent(filter, perfNow);
      return;
    }

    const curSpanStart = this.spanStartOfMs(this.cursorMs);
    const curSpan = this.loader.get(this.spanKey(curSpanStart));
    if (curSpan && this.eventCursor > 0) {
      for (let i = this.eventCursor - 1; i >= 0; i--) {
        if (spanMatchesFilter(curSpan.eventKind[i]!, filter)) {
          this.seekMs(curSpan.eventRecvMs[i]!);
          return;
        }
      }
    }
    const prevSpanStart = this.prevAvailableSpan(curSpanStart);
    if (prevSpanStart === null) return;
    this.ensurePrefetchWindow(prevSpanStart);
    const prevSpan = this.loader.get(this.spanKey(prevSpanStart));
    if (!prevSpan) {
      this.seekMs((prevSpanStart + SPAN_MINUTES) * MS_PER_MINUTE - 1);
      return;
    }
    for (let i = prevSpan.eventRecvMs.length - 1; i >= 0; i--) {
      if (spanMatchesFilter(prevSpan.eventKind[i]!, filter)) {
        this.seekMs(prevSpan.eventRecvMs[i]!);
        return;
      }
    }
  }

  stepFrameForTest(dtMs: number): void {
    this.onAnimationTick(dtMs, this.nowPerf());
  }

  dispose(): void {
    this.disposed = true;
    this.stopLoop();
    this.loader.dispose();
    this.frameListeners.clear();
    this.controlListeners.clear();
    this.marketStepListeners.clear();
    this.seekListeners.clear();
  }

  private spanStartOfMs(ms: number): number {
    return Math.floor(Math.max(0, ms) / SPAN_MS) * SPAN_MINUTES;
  }

  private spanKey(startMinute: number): string {
    return `${this.code}:${this.session.date}:${startMinute}`;
  }

  private hasSpanOnServer(startMinute: number): boolean {
    return this.availableSpans.includes(startMinute);
  }

  private nextAvailableSpan(afterStartMinute: number): number | null {
    for (const s of this.availableSpans) {
      if (s > afterStartMinute) return s;
    }
    return null;
  }

  private prevAvailableSpan(beforeStartMinute: number): number | null {
    for (let i = this.availableSpans.length - 1; i >= 0; i--) {
      if (this.availableSpans[i]! < beforeStartMinute) return this.availableSpans[i]!;
    }
    return null;
  }

  private ensurePrefetchWindow(centerSpanStart: number): void {
    if (this.resolution !== "tick") return;
    const targets: number[] = [];
    for (const offset of PREFETCH_OFFSETS) {
      const candidate = centerSpanStart + offset * SPAN_MINUTES;
      if (candidate >= 0 && candidate < 1440 && this.hasSpanOnServer(candidate)) {
        targets.push(candidate);
      }
    }
    const nextNonEmpty = this.nextAvailableSpan(centerSpanStart);
    if (nextNonEmpty !== null && !targets.includes(nextNonEmpty)) {
      targets.push(nextNonEmpty);
    }
    this.loader.setProtected(targets.map((s) => this.spanKey(s)));
    for (const startMin of targets) {
      this.loader.request(this.spanKey(startMin), bookReplaySpanUrl(this.code, this.session.date, startMin));
    }
  }

  private handleSpanLoaded(key: string): void {
    if (this.disposed) return;
    const expectedKey = this.spanKey(this.spanStartOfMs(this.cursorMs));
    if (key === expectedKey) {
      const spanStart = this.spanStartOfMs(this.cursorMs);
      const span = this.loader.get(key);
      this.buffering = false;
      if (span) {
        this.reconstructFromSpan(spanStart, span, this.cursorMs);
      } else {
        this.restoreEmptyAt(this.cursorMs);
      }
      this.emitControl();
      this.emitFrame();
      return;
    }
    this.emitControl();
  }

  private startLoop(): void {
    if (this.rafId !== 0 || typeof requestAnimationFrame === "undefined") return;
    const tick = (now: number) => {
      if (this.disposed || !this.playing) {
        this.rafId = 0;
        return;
      }
      const dtMs = this.lastRafMs === 0 ? 16 : Math.min(MAX_FRAME_DT_MS, Math.max(0, now - this.lastRafMs));
      this.lastRafMs = now;
      this.onAnimationTick(dtMs, now);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== 0 && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private onAnimationTick(dtMs: number, perfNow: number): void {
    if (!this.playing) return;
    const endMs = this.session.sessionEndSec * 1000 - 100;

    if (this.resolution === "minute_only") {
      const prevMs = this.cursorMs;
      const speed = this.mode.kind === "time" ? this.mode.speed : Math.max(1, this.mode.rateHz / 2);
      let next = this.cursorMs + dtMs * speed;
      if (this.loop && next >= this.loop.bMs) {
        this.seekMs(this.loop.aMs, { fromLoop: true });
        return;
      }
      if (next >= endMs) {
        this.cursorMs = endMs;
        this.scanMinuteOnlyForward(prevMs, endMs);
        this.setPlaying(false);
        return;
      }
      this.cursorMs = next;
      this.scanMinuteOnlyForward(prevMs, next);
      const nextSec = Math.floor(next / 1000);
      if (nextSec !== this.activeSecond) {
        this.activeSecond = nextSec;
        this.emitControl();
      }
      this.emitFrame();
      return;
    }

    if (this.mode.kind === "time") {
      this.advanceTimeMode(dtMs, perfNow, endMs);
    } else {
      this.advanceTickMode(dtMs, perfNow, endMs);
    }
  }

  private advanceTimeMode(dtMs: number, perfNow: number, endMs: number): void {
    if (this.mode.kind !== "time") return;
    const curSpanStart = this.spanStartOfMs(this.cursorMs);
    this.ensurePrefetchWindow(curSpanStart);
    const curSpan = this.loader.get(this.spanKey(curSpanStart));
    if (!curSpan && this.hasSpanOnServer(curSpanStart) && !this.loader.hasFailed(this.spanKey(curSpanStart))) {
      if (!this.buffering) {
        this.buffering = true;
        this.emitControl();
        this.emitFrame();
      }
      return;
    }
    if (this.buffering) {
      this.buffering = false;
      this.emitControl();
    }

    if (this.mode.skipIdleMs !== null) {
      const nextEvMs = this.peekNextEventMs(curSpanStart, curSpan);
      if (nextEvMs !== null && nextEvMs - this.cursorMs > this.mode.skipIdleMs) {
        const jumpTo = Math.max(this.cursorMs, nextEvMs - 250);
        const skipped = jumpTo - this.cursorMs;
        if (skipped > 500) {
          this.skipNotice = { skippedMs: skipped, untilMs: perfNow + SKIP_NOTICE_DURATION_MS };
          this.cursorMs = jumpTo;
          const jumpSpanStart = this.spanStartOfMs(jumpTo);
          if (jumpSpanStart !== curSpanStart) {
            this.seekMs(jumpTo);
            return;
          }
        }
      }
    }

    const nextMs = this.cursorMs + dtMs * this.mode.speed;
    if (this.loop && nextMs >= this.loop.bMs) {
      this.seekMs(this.loop.aMs, { fromLoop: true });
      return;
    }
    if (nextMs >= endMs) {
      this.seekMs(endMs);
      this.setPlaying(false);
      return;
    }

    const nextSpanStart = this.spanStartOfMs(nextMs);
    if (nextSpanStart !== curSpanStart) {
      this.ensurePrefetchWindow(nextSpanStart);
      if (this.hasSpanOnServer(nextSpanStart) && !this.loader.peek(this.spanKey(nextSpanStart)) && !this.loader.hasFailed(this.spanKey(nextSpanStart))) {
        this.buffering = true;
        this.emitControl();
        this.emitFrame();
        return;
      }
      if (curSpan) {
        this.drainSpanUpTo(curSpanStart, curSpan, (curSpanStart + SPAN_MINUTES) * MS_PER_MINUTE - 1, perfNow);
      }
      this.cursorMs = nextMs;
      const nextSpan = this.loader.get(this.spanKey(nextSpanStart));
      if (nextSpan) {
        this.activeSpanStart = nextSpanStart;
        this.eventCursor = -1;
        this.drainSpanUpTo(nextSpanStart, nextSpan, nextMs, perfNow);
      } else {
        this.activeSpanStart = nextSpanStart;
        this.eventCursor = -1;
      }
    } else {
      this.cursorMs = nextMs;
      if (curSpan) {
        if (this.activeSpanStart !== curSpanStart) {
          this.reconstructFromSpan(curSpanStart, curSpan, nextMs);
        } else {
          this.drainSpanUpTo(curSpanStart, curSpan, nextMs, perfNow);
        }
      }
    }

    const nextSec = Math.floor(this.cursorMs / 1000);
    if (nextSec !== this.activeSecond) {
      this.activeSecond = nextSec;
      this.emitControl();
    }
    this.emitFrame();
  }

  private advanceTickMode(dtMs: number, perfNow: number, endMs: number): void {
    if (this.mode.kind !== "tick") return;
    this.tickBudget += (dtMs / 1000) * this.mode.rateHz;
    let steps = 0;
    const maxStepsPerFrame = 40;
    while (this.tickBudget >= 1 && steps < maxStepsPerFrame) {
      const progressed = this.advanceOneMatchingEvent(this.mode.filter, perfNow, false);
      this.tickBudget -= 1;
      steps += 1;
      if (!progressed) break;
      if (this.loop && this.cursorMs >= this.loop.bMs) {
        this.seekMs(this.loop.aMs, { fromLoop: true });
        return;
      }
      if (this.cursorMs >= endMs) {
        this.setPlaying(false);
        return;
      }
    }
    const nextSec = Math.floor(this.cursorMs / 1000);
    if (nextSec !== this.activeSecond) {
      this.activeSecond = nextSec;
      this.emitControl();
    }
    this.emitFrame();
  }

  private advanceOneMatchingEvent(filter: TickEventFilter, perfNow: number, emit = true): boolean {
    let spanStart = this.spanStartOfMs(this.cursorMs);
    this.ensurePrefetchWindow(spanStart);
    let span = this.loader.get(this.spanKey(spanStart));
    if (!span && this.hasSpanOnServer(spanStart) && !this.loader.hasFailed(this.spanKey(spanStart))) {
      this.buffering = true;
      if (emit) {
        this.emitControl();
        this.emitFrame();
      }
      return false;
    }

    while (true) {
      if (span) {
        if (this.activeSpanStart !== spanStart) {
          this.activeSpanStart = spanStart;
          this.eventCursor = -1;
        }
        while (this.eventCursor + 1 < span.eventRecvMs.length) {
          this.eventCursor += 1;
          const evMs = span.eventRecvMs[this.eventCursor]!;
          const evKind = span.eventKind[this.eventCursor]!;
          const evRow = span.eventRow[this.eventCursor]!;
          this.applyEvent(spanStart, span, evMs, evKind, evRow, true, perfNow);
          this.cursorMs = evMs;
          if (spanMatchesFilter(evKind, filter)) {
            this.buffering = false;
            if (emit) {
              this.activeSecond = Math.floor(this.cursorMs / 1000);
              this.emitControl();
              this.emitFrame();
            }
            return true;
          }
        }
      }
      const nextStart = this.nextAvailableSpan(spanStart);
      if (nextStart === null) {
        if (this.playing) this.setPlaying(false);
        return false;
      }
      this.ensurePrefetchWindow(nextStart);
      const nextSpan = this.loader.get(this.spanKey(nextStart));
      if (!nextSpan) {
        this.cursorMs = nextStart * MS_PER_MINUTE;
        this.activeSpanStart = nextStart;
        this.eventCursor = -1;
        this.buffering = true;
        if (emit) {
          this.emitControl();
          this.emitFrame();
        }
        return false;
      }
      spanStart = nextStart;
      span = nextSpan;
      this.activeSpanStart = spanStart;
      this.eventCursor = -1;
    }
  }

  private peekNextEventMs(curSpanStart: number, curSpan: OpenedHogaSpan | null): number | null {
    if (curSpan && this.eventCursor + 1 < curSpan.eventRecvMs.length) {
      return curSpan.eventRecvMs[this.eventCursor + 1]!;
    }
    const nextStart = this.nextAvailableSpan(curSpanStart);
    if (nextStart === null) return null;
    const nextSpan = this.loader.peek(this.spanKey(nextStart));
    if (nextSpan && nextSpan.eventRecvMs.length > 0) {
      return nextSpan.eventRecvMs[0]!;
    }
    return nextStart * MS_PER_MINUTE;
  }

  private drainSpanUpTo(spanStart: number, span: OpenedHogaSpan, limitMs: number, perfNow: number): void {
    while (this.eventCursor + 1 < span.eventRecvMs.length && span.eventRecvMs[this.eventCursor + 1]! <= limitMs) {
      this.eventCursor += 1;
      const evMs = span.eventRecvMs[this.eventCursor]!;
      const evKind = span.eventKind[this.eventCursor]!;
      const evRow = span.eventRow[this.eventCursor]!;
      this.applyEvent(spanStart, span, evMs, evKind, evRow, true, perfNow);
    }
    this.pruneOneMinDeque(limitMs);
  }

  private applyEvent(
    spanStart: number,
    span: OpenedHogaSpan,
    evMs: number,
    evKind: number,
    evRow: number,
    liveFlash: boolean,
    perfNow: number,
  ): void {
    const minute = Math.floor(evMs / MS_PER_MINUTE);
    if (minute !== this.lastBookMinute) {
      this.minuteStartBook = this.currentBook;
      this.lastBookMinute = minute;
    }
    this.deltaMs = Math.max(0, evMs - this.lastEventMs);
    this.lastEventMs = evMs;

    if (evKind === EVENT_KIND_BOOK) {
      const prev = this.currentBook;
      const next = extractBookRow(span, evRow);
      this.prevBook = prev;
      this.currentBook = next;
      if (liveFlash) {
        this.recordBookFlashes(prev, next, perfNow);
      }
      this.emitMarketStep({
        ms: evMs,
        tradePrice: null,
        bestAsk: next.asks[0]?.price ?? null,
        bestBid: next.bids[0]?.price ?? null,
      });
    } else if (evKind === EVENT_KIND_TRADE) {
      const tr = extractTradeRow(span, spanStart, evRow, liveFlash ? perfNow + FLASH_DURATION_MS : 0);
      if (!tr) return;
      this.price = tr.price;
      if (this.dayOpen === null) this.dayOpen = tr.price;
      if (this.dayHigh === null || tr.price > this.dayHigh) this.dayHigh = tr.price;
      if (this.dayLow === null || tr.price < this.dayLow) this.dayLow = tr.price;
      this.cumVol += tr.quantity;
      this.cumVal += tr.value;
      if (tr.side === "buy") this.cumBuyQty += tr.quantity;
      else if (tr.side === "sell") this.cumSellQty += tr.quantity;

      if (this.formingBar === null || this.formingBar.minute !== minute) {
        this.formingBar = {
          minute,
          open: tr.price,
          high: tr.price,
          low: tr.price,
          close: tr.price,
          volume: tr.quantity,
        };
      } else {
        this.formingBar = {
          minute,
          open: this.formingBar.open,
          high: Math.max(this.formingBar.high, tr.price),
          low: Math.min(this.formingBar.low, tr.price),
          close: tr.price,
          volume: this.formingBar.volume + tr.quantity,
        };
      }

      this.recentTrades.unshift(tr);
      if (this.recentTrades.length > MAX_RECENT_TRADES) this.recentTrades.length = MAX_RECENT_TRADES;
      this.oneMinDeque.push(tr);
      if (tr.side === "buy") this.oneMinNetQty += tr.quantity;
      else if (tr.side === "sell") this.oneMinNetQty -= tr.quantity;
      if (tr.whale) {
        if (tr.side === "buy") this.whaleBuy += 1;
        else if (tr.side === "sell") this.whaleSell += 1;
      }
      this.pruneOneMinDeque(evMs);

      if (liveFlash && tr.side !== "none") {
        this.hitRow = { price: tr.price, side: tr.side, untilMs: perfNow + HIT_DURATION_MS };
      }
      this.emitMarketStep({
        ms: evMs,
        tradePrice: tr.price,
        bestAsk: this.currentBook.asks[0]?.price ?? null,
        bestBid: this.currentBook.bids[0]?.price ?? null,
      });
    } else if (evKind === EVENT_KIND_PROGRAM) {
      const prog = extractProgramRow(span, evRow);
      if (prog) {
        this.programNetQty = prog.netQty;
        this.programNetAmtMillion = prog.netAmtMillion;
      }
    }
  }

  private recordBookFlashes(prev: ReplayBookState, next: ReplayBookState, perfNow: number): void {
    const untilMs = perfNow + FLASH_DURATION_MS;
    const prevAsks = new Map(prev.asks.map((l) => [l.price, l.quantity]));
    for (const lvl of next.asks) {
      const old = prevAsks.get(lvl.price);
      if (old !== undefined && old !== lvl.quantity) {
        this.cellFlashes.set(`ask:${lvl.price}`, { dir: lvl.quantity > old ? 1 : -1, untilMs });
      }
    }
    const prevBids = new Map(prev.bids.map((l) => [l.price, l.quantity]));
    for (const lvl of next.bids) {
      const old = prevBids.get(lvl.price);
      if (old !== undefined && old !== lvl.quantity) {
        this.cellFlashes.set(`bid:${lvl.price}`, { dir: lvl.quantity > old ? 1 : -1, untilMs });
      }
    }
  }

  private pruneOneMinDeque(nowMs: number): void {
    const cutoff = nowMs - MS_PER_MINUTE;
    while (this.oneMinDeque.length > 0 && this.oneMinDeque[0]!.recvMs < cutoff) {
      const removed = this.oneMinDeque.shift()!;
      if (removed.side === "buy") this.oneMinNetQty -= removed.quantity;
      else if (removed.side === "sell") this.oneMinNetQty += removed.quantity;
    }
  }

  private findCheckpointAtOrBefore(minute: number): BookReplayMinuteCheckpoint | null {
    const exact = this.checkpointByMin.get(minute);
    if (exact) return exact;
    let best: BookReplayMinuteCheckpoint | null = null;
    if (this.meta) {
      for (const ck of this.meta.minutes) {
        if (ck.minute <= minute) best = ck;
        else break;
      }
    }
    return best;
  }

  private restoreEmptyAt(targetMs: number): void {
    const targetMin = Math.floor(targetMs / MS_PER_MINUTE);
    const ck = this.findCheckpointAtOrBefore(targetMin);
    this.currentBook = EMPTY_BOOK;
    this.prevBook = null;
    this.minuteStartBook = null;
    this.lastBookMinute = targetMin;
    this.formingBar = null;
    this.recentTrades = [];
    this.oneMinDeque = [];
    this.oneMinNetQty = 0;
    this.whaleBuy = 0;
    this.whaleSell = 0;
    this.cumVol = ck?.cumVol ?? 0;
    this.cumVal = ck?.cumVal ?? 0;
    this.cumBuyQty = ck?.cumBuyQty ?? 0;
    this.cumSellQty = ck?.cumSellQty ?? 0;
    this.dayOpen = ck?.dayOpen ?? null;
    this.dayHigh = ck?.dayHigh ?? null;
    this.dayLow = ck?.dayLow ?? null;
    this.price = ck?.close ?? null;
    this.programNetQty = ck?.programNetQty ?? null;
    this.programNetAmtMillion = ck?.programNetAmtMillion ?? null;
    this.lastEventMs = targetMs;
    this.deltaMs = 0;
    this.activeSecond = Math.floor(targetMs / 1000);
  }

  private reconstructFromSpan(spanStart: number, span: OpenedHogaSpan, targetMs: number): void {
    this.activeSpanStart = spanStart;
    const targetMin = Math.floor(targetMs / MS_PER_MINUTE);
    const minStartMs = targetMin * MS_PER_MINUTE;
    const ck = this.findCheckpointAtOrBefore(targetMin);

    this.cumVol = ck?.cumVol ?? 0;
    this.cumVal = ck?.cumVal ?? 0;
    this.cumBuyQty = ck?.cumBuyQty ?? 0;
    this.cumSellQty = ck?.cumSellQty ?? 0;
    this.dayOpen = ck?.dayOpen ?? null;
    this.dayHigh = ck?.dayHigh ?? null;
    this.dayLow = ck?.dayLow ?? null;
    this.price = ck?.close ?? null;
    this.programNetQty = ck?.programNetQty ?? null;
    this.programNetAmtMillion = ck?.programNetAmtMillion ?? null;
    this.lastBookMinute = targetMin;

    const bookStream = span.streams.book;
    if (bookStream && bookStream.rows > 0) {
      const recv = bookStream.columns.recv_ms!;
      const row = lastRowAtOrBefore(recv, targetMs);
      this.currentBook = row >= 0 ? extractBookRow(span, row) : EMPTY_BOOK;
      this.prevBook = row > 0 ? extractBookRow(span, row - 1) : null;
      const minStartRow = lastRowAtOrBefore(recv, minStartMs);
      this.minuteStartBook = minStartRow >= 0 ? extractBookRow(span, minStartRow) : this.prevBook;
    } else {
      this.currentBook = EMPTY_BOOK;
      this.prevBook = null;
      this.minuteStartBook = null;
    }

    const programStream = span.streams.program;
    if (programStream && programStream.rows > 0) {
      const pRow = lastRowAtOrBefore(programStream.columns.recv_ms!, targetMs);
      if (pRow >= 0) {
        const prog = extractProgramRow(span, pRow);
        if (prog) {
          this.programNetQty = prog.netQty;
          this.programNetAmtMillion = prog.netAmtMillion;
        }
      }
    }

    this.formingBar = null;
    this.recentTrades = [];
    this.oneMinDeque = [];
    this.oneMinNetQty = 0;
    this.whaleBuy = 0;
    this.whaleSell = 0;

    const tradeStream = span.streams.trades;
    if (tradeStream && tradeStream.rows > 0) {
      const tRecv = tradeStream.columns.recv_ms!;
      const endRow = lastRowAtOrBefore(tRecv, targetMs);
      const minFirstRow = firstRowAtOrAfter(tRecv, minStartMs);
      for (let r = minFirstRow; r <= endRow; r++) {
        const tr = extractTradeRow(span, spanStart, r, 0);
        if (!tr) continue;
        this.price = tr.price;
        if (this.dayOpen === null) this.dayOpen = tr.price;
        if (this.dayHigh === null || tr.price > this.dayHigh) this.dayHigh = tr.price;
        if (this.dayLow === null || tr.price < this.dayLow) this.dayLow = tr.price;
        this.cumVol += tr.quantity;
        this.cumVal += tr.value;
        if (tr.side === "buy") this.cumBuyQty += tr.quantity;
        else if (tr.side === "sell") this.cumSellQty += tr.quantity;
        if (this.formingBar === null) {
          this.formingBar = {
            minute: targetMin,
            open: tr.price,
            high: tr.price,
            low: tr.price,
            close: tr.price,
            volume: tr.quantity,
          };
        } else {
          this.formingBar = {
            minute: targetMin,
            open: this.formingBar.open,
            high: Math.max(this.formingBar.high, tr.price),
            low: Math.min(this.formingBar.low, tr.price),
            close: tr.price,
            volume: this.formingBar.volume + tr.quantity,
          };
        }
      }

      const oneMinStartRow = firstRowAtOrAfter(tRecv, targetMs - MS_PER_MINUTE);
      for (let r = oneMinStartRow; r <= endRow; r++) {
        const tr = extractTradeRow(span, spanStart, r, 0);
        if (!tr) continue;
        this.oneMinDeque.push(tr);
        if (tr.side === "buy") this.oneMinNetQty += tr.quantity;
        else if (tr.side === "sell") this.oneMinNetQty -= tr.quantity;
      }

      for (let r = endRow; r >= 0 && this.recentTrades.length < MAX_RECENT_TRADES; r--) {
        const tr = extractTradeRow(span, spanStart, r, 0);
        if (!tr) continue;
        this.recentTrades.push(tr);
        if (tr.whale) {
          if (tr.side === "buy") this.whaleBuy += 1;
          else if (tr.side === "sell") this.whaleSell += 1;
        }
      }
      if (this.price === null && endRow >= 0) {
        const lastTr = extractTradeRow(span, spanStart, endRow, 0);
        if (lastTr) this.price = lastTr.price;
      }
    }

    if (this.recentTrades.length < MAX_RECENT_TRADES && spanStart >= SPAN_MINUTES) {
      const prevSpan = this.loader.peek(this.spanKey(spanStart - SPAN_MINUTES));
      const prevTrades = prevSpan?.streams.trades;
      if (prevSpan && prevTrades && prevTrades.rows > 0) {
        for (let r = prevTrades.rows - 1; r >= 0 && this.recentTrades.length < MAX_RECENT_TRADES; r--) {
          const tr = extractTradeRow(prevSpan, spanStart - SPAN_MINUTES, r, 0);
          if (!tr) continue;
          this.recentTrades.push(tr);
        }
      }
    }

    this.eventCursor = lastRowAtOrBefore(span.eventRecvMs, targetMs);
    this.lastEventMs = this.eventCursor >= 0 ? span.eventRecvMs[this.eventCursor]! : targetMs;
    this.deltaMs = this.eventCursor > 0
      ? Math.max(0, span.eventRecvMs[this.eventCursor]! - span.eventRecvMs[this.eventCursor - 1]!)
      : 0;
    this.activeSecond = Math.floor(targetMs / 1000);
  }

  private isInGapMs(ms: number): boolean {
    if (this.meta && this.meta.gapsMs.length > 0) {
      for (const [from, to] of this.meta.gapsMs) {
        if (ms >= from && ms < to) return true;
      }
    }
    const sec = ms / 1000;
    for (const gw of this.session.gapWindows) {
      if (sec >= gw.startSec && sec < gw.endSec) return true;
    }
    return false;
  }

  private strengthNow(): number {
    if (this.cumBuyQty === 0 && this.cumSellQty === 0) return 100;
    if (this.cumSellQty === 0) return 300;
    return Math.min(500, (this.cumBuyQty / this.cumSellQty) * 100);
  }

  private buildSnapshot(perfNow: number): ReplayEngineFrame {
    if (this.resolution === "minute_only") {
      const sec = this.cursorMs / 1000;
      const idx = frameIndexAt(this.session.frames, sec);
      const frame = idx >= 0 ? (this.session.frames[idx] ?? null) : null;
      const ladder = computeLadderSnapshot(this.session, idx, this.deltaMode);
      const tradeSummary = filterRecentTrades(this.session.frames, idx, this.tapeMinWon);
      return {
        cursorMs: this.cursorMs,
        deltaMs: 0,
        playing: this.playing,
        buffering: false,
        resolution: "minute_only",
        price: frame?.price ?? null,
        dayOpen: frame?.open ?? null,
        dayHigh: frame?.high ?? null,
        dayLow: frame?.low ?? null,
        cumVol: frame?.cumVol ?? 0,
        cumVal: frame?.cumVal ?? 0,
        vwap: frame && frame.cumVol > 0 ? frame.cumVal / frame.cumVol : (frame?.price ?? null),
        strength: frame?.strength ?? 100,
        programNetQty: frame?.programNetQty ?? null,
        programNetAmtMillion: frame?.programNetAmtMillion ?? null,
        inGap: frame?.inGap ?? false,
        singlePrice: frame?.singlePrice ?? false,
        formingBar: null,
        ladder,
        cellFlashes: new Map(),
        hitRow: null,
        tradeSummary,
        recentTrades: tradeSummary.rows.map((tr) => ({ ...tr, recvMs: tr.secondOfDay * 1000, freshUntilMs: 0 })),
        skipNotice: null,
        loadedSpans: [],
      };
    }

    for (const [key, flash] of this.cellFlashes) {
      if (perfNow >= flash.untilMs) this.cellFlashes.delete(key);
    }
    if (this.hitRow && perfNow >= this.hitRow.untilMs) {
      this.hitRow = null;
    }
    if (this.skipNotice && perfNow >= this.skipNotice.untilMs) {
      this.skipNotice = null;
    }

    const inGap = this.isInGapMs(this.cursorMs);
    const singlePrice = !inGap && isSinglePriceBook(this.currentBook.asks, this.currentBook.bids);
    const refBook = this.deltaMode === "tick"
      ? this.prevBook
      : this.deltaMode === "min"
        ? this.minuteStartBook
        : null;
    const ladder = buildLadderFromBooks(
      this.currentBook,
      refBook,
      this.deltaMode,
      inGap,
      singlePrice,
      this.price,
      this.dayOpen,
      this.dayHigh,
      this.dayLow,
      this.session.previousClose,
      this.session.tickStepOf,
      this.hitRow?.side ?? null,
    );

    const filteredTrades = this.tapeMinWon > 0
      ? this.recentTrades.filter((tr) => tr.value >= this.tapeMinWon).slice(0, 40)
      : this.recentTrades.slice(0, 40);

    const loadedSpans = this.loader
      .cachedKeys()
      .map((key) => Number(key.slice(key.lastIndexOf(":") + 1)))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    return {
      cursorMs: this.cursorMs,
      deltaMs: this.deltaMs,
      playing: this.playing,
      buffering: this.buffering,
      resolution: "tick",
      price: this.price,
      dayOpen: this.dayOpen,
      dayHigh: this.dayHigh,
      dayLow: this.dayLow,
      cumVol: this.cumVol,
      cumVal: this.cumVal,
      vwap: this.cumVol > 0 ? this.cumVal / this.cumVol : this.price,
      strength: this.strengthNow(),
      programNetQty: this.programNetQty,
      programNetAmtMillion: this.programNetAmtMillion,
      inGap,
      singlePrice,
      formingBar: this.formingBar,
      ladder,
      cellFlashes: new Map(this.cellFlashes),
      hitRow: this.hitRow,
      tradeSummary: {
        rows: filteredTrades,
        net1mQty: this.oneMinNetQty,
        whaleBuy: this.whaleBuy,
        whaleSell: this.whaleSell,
      },
      recentTrades: filteredTrades,
      skipNotice: this.skipNotice,
      loadedSpans,
    };
  }

  private emitFrame(): void {
    this.cachedFrame = this.buildSnapshot(this.nowPerf());
    for (const listener of this.frameListeners) {
      listener(this.cachedFrame);
    }
  }

  private emitControl(): void {
    const state = this.getControlState();
    for (const listener of this.controlListeners) {
      listener(state);
    }
  }

  private emitMarketStep(step: ReplayMarketStepEvent): void {
    for (const listener of this.marketStepListeners) {
      listener(step);
    }
  }

  private emitSeek(event: ReplaySeekEvent): void {
    for (const listener of this.seekListeners) {
      listener(event);
    }
  }

  private scanMinuteOnlyForward(fromMs: number, toMs: number): void {
    if (this.marketStepListeners.size === 0 || this.session.frames.length === 0) return;
    const startIdx = Math.max(0, frameIndexAt(this.session.frames, fromMs / 1000) + 1);
    const endIdx = frameIndexAt(this.session.frames, toMs / 1000);
    for (let i = startIdx; i <= endIdx; i++) {
      const f = this.session.frames[i];
      if (!f || f.inGap) continue;
      this.emitMarketStep({
        ms: f.t * 1000,
        tradePrice: f.trade?.price ?? f.price,
        bestAsk: f.asks[0]?.price ?? null,
        bestBid: f.bids[0]?.price ?? null,
      });
    }
  }

  private scanTickForward(fromMs: number, toMs: number): void {
    if (this.marketStepListeners.size === 0) return;
    const fromSpan = this.spanStartOfMs(fromMs);
    const toSpan = this.spanStartOfMs(toMs);
    for (let s = fromSpan; s <= toSpan; s += SPAN_MINUTES) {
      const span = this.loader.peek(this.spanKey(s));
      if (span) {
        const startRow = firstRowAtOrAfter(span.eventRecvMs, fromMs + 1);
        const endRow = lastRowAtOrBefore(span.eventRecvMs, toMs);
        let bestAsk = this.currentBook.asks[0]?.price ?? null;
        let bestBid = this.currentBook.bids[0]?.price ?? null;
        for (let i = startRow; i <= endRow; i++) {
          const evMs = span.eventRecvMs[i]!;
          const evKind = span.eventKind[i]!;
          const evRow = span.eventRow[i]!;
          if (evKind === EVENT_KIND_BOOK) {
            const book = extractBookRow(span, evRow);
            bestAsk = book.asks[0]?.price ?? null;
            bestBid = book.bids[0]?.price ?? null;
            this.emitMarketStep({ ms: evMs, tradePrice: null, bestAsk, bestBid });
          } else if (evKind === EVENT_KIND_TRADE) {
            const tr = extractTradeRow(span, s, evRow, 0);
            if (tr) {
              this.emitMarketStep({ ms: evMs, tradePrice: tr.price, bestAsk, bestBid });
            }
          }
        }
      } else {
        const startMin = Math.max(s, Math.floor(fromMs / MS_PER_MINUTE));
        const endMin = Math.min(s + SPAN_MINUTES - 1, Math.floor(toMs / MS_PER_MINUTE));
        for (let m = startMin; m <= endMin; m++) {
          const ck = this.checkpointByMin.get(m);
          if (!ck) continue;
          const mMs = Math.min(toMs, m * MS_PER_MINUTE + 30_000);
          if (ck.low !== null) this.emitMarketStep({ ms: mMs, tradePrice: ck.low, bestAsk: null, bestBid: null });
          if (ck.high !== null) this.emitMarketStep({ ms: mMs, tradePrice: ck.high, bestAsk: null, bestBid: null });
        }
      }
    }
  }
}
