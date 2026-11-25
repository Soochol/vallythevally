import type { Bar } from "../../api/generated/Bar";
import type { FeedProgramRow } from "../../api/generated/FeedProgramRow";
import type { FeedTrade } from "../../api/generated/FeedTrade";
import type { MicroSeriesState } from "../../api/generated/MicroSeriesState";
import type { Period } from "../../api/generated/Period";
import type { ProgramSeriesPage } from "../../api/generated/ProgramSeriesPage";
import type { ProgramSeriesPoint } from "../../api/generated/ProgramSeriesPoint";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { TickCvdPage } from "../../api/generated/TickCvdPage";
import type { TickCvdPoint } from "../../api/generated/TickCvdPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { fetchProgramSeries, fetchTickCvd, type MicroRange } from "../../api/microSeries";
import { MINUS } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import { kstDateOf } from "../barJump";
import type { IndicatorConfig } from "../settings";
import { indicatorColorValue, type ThemeTokens } from "../theme";
import { isIntraday } from "../time";
import { isProgramFlow, isTickCvd, LINE_LABEL, lineColor, type PlotLineId, specLines, specName } from "./kinds";
import type { IndicatorRow, LegendValue } from "./layer";

export const MID_MIN_WON = 5_000_000;
export const LARGE_MIN_WON = 30_000_000;
export const WHALE_MIN_WON = 100_000_000;

export type TickTier = "retail" | "mid" | "large" | "whale";

export function classifyTickTier(valueWon: number): TickTier {
  if (valueWon >= WHALE_MIN_WON) return "whale";
  if (valueWon >= LARGE_MIN_WON) return "large";
  if (valueWon >= MID_MIN_WON) return "mid";
  return "retail";
}

const INTRADAY_MINUTES: Readonly<Partial<Record<Period, number>>> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "10m": 10,
  "15m": 15,
  "30m": 30,
  "60m": 60,
};

export function bucketStartSec(unixSec: UnixSeconds, period: Period): UnixSeconds | null {
  const minutes = INTRADAY_MINUTES[period];
  if (minutes === undefined) return null;
  const periodSec = minutes * 60;
  return Math.floor(unixSec / periodSec) * periodSec;
}

function addTierDelta(point: TickCvdPoint, tier: TickTier, deltaMillionWon: number): TickCvdPoint {
  switch (tier) {
    case "whale":
      return { ...point, whaleNetMillionWon: point.whaleNetMillionWon + deltaMillionWon };
    case "large":
      return { ...point, largeNetMillionWon: point.largeNetMillionWon + deltaMillionWon };
    case "mid":
      return { ...point, midNetMillionWon: point.midNetMillionWon + deltaMillionWon };
    case "retail":
      return { ...point, retailNetMillionWon: point.retailNetMillionWon + deltaMillionWon };
  }
}

export function applyLiveTradeToPoints(
  points: Map<UnixSeconds, TickCvdPoint>,
  tick: FeedTrade,
  period: Period,
): TickCvdPoint | null {
  const bucketT = bucketStartSec(tick.t, period);
  if (bucketT === null || tick.qty === 0 || tick.price <= 0) return null;
  const valueWon = Math.abs(tick.price * tick.qty);
  const deltaMillionWon = (tick.price * tick.qty) / 1_000_000;
  const tier = classifyTickTier(valueWon);
  const day = kstDateOf(bucketT);
  const existing = points.get(bucketT);
  if (existing !== undefined) {
    const updated = addTierDelta(existing, tier, deltaMillionWon);
    points.set(bucketT, updated);
    for (const [t, pt] of points) {
      if (t > bucketT && kstDateOf(t) === day) points.set(t, addTierDelta(pt, tier, deltaMillionWon));
    }
    return updated;
  }
  let prevSameDay: TickCvdPoint | null = null;
  for (const [t, pt] of points) {
    if (t < bucketT && kstDateOf(t) === day && (prevSameDay === null || t > prevSameDay.t)) {
      prevSameDay = pt;
    }
  }
  const base: TickCvdPoint = prevSameDay
    ? {
        t: bucketT,
        whaleNetMillionWon: prevSameDay.whaleNetMillionWon,
        largeNetMillionWon: prevSameDay.largeNetMillionWon,
        midNetMillionWon: prevSameDay.midNetMillionWon,
        retailNetMillionWon: prevSameDay.retailNetMillionWon,
      }
    : {
        t: bucketT,
        whaleNetMillionWon: 0,
        largeNetMillionWon: 0,
        midNetMillionWon: 0,
        retailNetMillionWon: 0,
      };
  const created = addTierDelta(base, tier, deltaMillionWon);
  points.set(bucketT, created);
  for (const [t, pt] of points) {
    if (t > bucketT && kstDateOf(t) === day) points.set(t, addTierDelta(pt, tier, deltaMillionWon));
  }
  return created;
}

export function applyLiveProgramToPoints(
  points: Map<UnixSeconds, ProgramSeriesPoint>,
  row: FeedProgramRow,
  period: Period,
  dayTradedWon?: number,
): ProgramSeriesPoint | null {
  const bucketT = bucketStartSec(row.t, period);
  if (bucketT === null) return null;
  const existing = points.get(bucketT);
  let programSharePct: number | null = existing?.programSharePct ?? null;
  if (dayTradedWon !== undefined && dayTradedWon > 0) {
    const raw = ((row.buyAmount + row.sellAmount) / (dayTradedWon / 1_000_000)) * 100;
    programSharePct = Math.min(100, Math.max(0, raw));
  }
  const next: ProgramSeriesPoint = {
    t: bucketT,
    netBuyAmountMillionWon: row.netAmount,
    netBuyQty: row.netQty,
    buyAmountMillionWon: row.buyAmount,
    sellAmountMillionWon: row.sellAmount,
    programSharePct,
  };
  points.set(bucketT, next);
  return next;
}

const intFmt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const dec1Fmt = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dec2Fmt = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMillionWon(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? MINUS : "";
  const abs = Math.abs(value);
  if (abs >= 100) return `${sign}${dec2Fmt.format(abs / 100)}억`;
  if (abs === 0) return "0백만";
  if (Math.abs(abs - Math.round(abs)) < 0.05) return `${sign}${intFmt.format(Math.round(abs))}백만`;
  return `${sign}${dec1Fmt.format(abs)}백만`;
}

export function formatSharePct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  return `${dec1Fmt.format(pct)}%`;
}

export type MicroFeedState = "loading" | MicroSeriesState | "unsupported" | "failed";

const MICRO_STATE_TEXT: Readonly<Partial<Record<MicroFeedState, string>>> = {
  disabled: "수집 폴더 미설정",
  not_collected: "수집하지 않는 종목",
  unsupported: "주식·ETF 분봉 전용",
  failed: "수급 자료 조회 실패",
};

export function microStateMessage(state: MicroFeedState): string | null {
  return MICRO_STATE_TEXT[state] ?? null;
}

export function tickCvdLineValue(lineId: PlotLineId, point: TickCvdPoint): number {
  switch (lineId) {
    case "cvdWhale":
      return point.whaleNetMillionWon;
    case "cvdLarge":
      return point.largeNetMillionWon;
    case "cvdMid":
      return point.midNetMillionWon;
    case "cvdRetail":
      return point.retailNetMillionWon;
    default:
      return 0;
  }
}

export function programLineValue(lineId: PlotLineId, point: ProgramSeriesPoint): number | null {
  if (lineId === "programShare") return point.programSharePct;
  return point.netBuyAmountMillionWon;
}

export interface MicroTarget {
  readonly symbol: SymbolCode;
  readonly period: Period;
}

export interface MicroFamilyDeps {
  readonly fetchTickCvd?: (symbol: SymbolCode, period: Period, range: MicroRange, signal: AbortSignal) => Promise<TickCvdPage>;
  readonly fetchProgramSeries?: (symbol: SymbolCode, period: Period, range: MicroRange, signal: AbortSignal) => Promise<ProgramSeriesPage>;
}

export interface MicroFamilyHost {
  bars(): readonly Bar[];
  tokens(): ThemeTokens;
  configs(): readonly IndicatorConfig[];
  onTickCvdChanged(from: UnixSeconds | null): void;
  onProgramChanged(from: UnixSeconds | null): void;
}

interface SeriesStore<P extends { t: UnixSeconds }> {
  key: string | null;
  gen: number;
  state: MicroFeedState;
  points: Map<UnixSeconds, P>;
  coveredFrom: UnixSeconds | null;
  liveLatestT: UnixSeconds | null;
  fetching: boolean;
  abort: AbortController | null;
}

function emptyStore<P extends { t: UnixSeconds }>(): SeriesStore<P> {
  return {
    key: null,
    gen: 0,
    state: "loading",
    points: new Map(),
    coveredFrom: null,
    liveLatestT: null,
    fetching: false,
    abort: null,
  };
}

function resetStore<P extends { t: UnixSeconds }>(store: SeriesStore<P>, key: string | null, state: MicroFeedState): void {
  store.gen++;
  store.abort?.abort();
  store.abort = null;
  store.fetching = false;
  store.key = key;
  store.state = state;
  store.points.clear();
  store.coveredFrom = null;
  store.liveLatestT = null;
}

function targetKey(target: MicroTarget): string {
  return `${target.symbol}:${target.period}`;
}

export class MicroIndicatorController {
  private readonly fetchCvd: (symbol: SymbolCode, period: Period, range: MicroRange, signal: AbortSignal) => Promise<TickCvdPage>;
  private readonly fetchProgram: (symbol: SymbolCode, period: Period, range: MicroRange, signal: AbortSignal) => Promise<ProgramSeriesPage>;
  private readonly cvd = emptyStore<TickCvdPoint>();
  private readonly program = emptyStore<ProgramSeriesPoint>();
  private readonly liveDayTradedWon = new Map<string, number>();
  private target: MicroTarget | null = null;
  private cvdActive = false;
  private programActive = false;
  private disposed = false;

  constructor(private readonly host: MicroFamilyHost, deps: MicroFamilyDeps = {}) {
    this.fetchCvd = deps.fetchTickCvd ?? fetchTickCvd;
    this.fetchProgram = deps.fetchProgramSeries ?? fetchProgramSeries;
  }

  setTarget(target: MicroTarget | null, sync = true): void {
    const prevKey = this.target ? targetKey(this.target) : null;
    const nextKey = target ? targetKey(target) : null;
    this.target = target;
    if (prevKey !== nextKey) this.liveDayTradedWon.clear();
    if (sync) this.syncFeeds();
  }

  syncFeeds(): void {
    const target = this.target;
    const configs = this.host.configs();
    const eligible = target !== null && !isIndexCode(target.symbol) && isIntraday(target.period);
    const hasCvd = configs.some((c) => isTickCvd(c.spec) && c.visible);
    const hasProgram = configs.some((c) => isProgramFlow(c.spec) && c.visible);

    this.cvdActive = eligible && hasCvd;
    if (!hasCvd) {
      if (this.cvd.key !== null || this.cvd.points.size > 0) resetStore(this.cvd, null, "loading");
    } else if (!eligible) {
      if (this.cvd.state !== "unsupported" || this.cvd.key !== null) {
        resetStore(this.cvd, null, "unsupported");
        this.host.onTickCvdChanged(null);
      }
    } else {
      const key = targetKey(target);
      if (this.cvd.key !== key) {
        resetStore(this.cvd, key, "loading");
        this.host.onTickCvdChanged(null);
      }
    }

    this.programActive = eligible && hasProgram;
    if (!hasProgram) {
      if (this.program.key !== null || this.program.points.size > 0) resetStore(this.program, null, "loading");
    } else if (!eligible) {
      if (this.program.state !== "unsupported" || this.program.key !== null) {
        resetStore(this.program, null, "unsupported");
        this.host.onProgramChanged(null);
      }
    } else {
      const key = targetKey(target);
      if (this.program.key !== key) {
        resetStore(this.program, key, "loading");
        this.host.onProgramChanged(null);
      }
    }

    this.cover(this.host.bars());
  }

  cover(bars: readonly Bar[]): void {
    if (this.disposed || !this.target) return;
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (!first || !last) return;
    if (this.cvdActive) this.coverCvd(this.target, first.t, last.t);
    if (this.programActive) this.coverProgram(this.target, first.t, last.t);
  }

  applyLiveTrade(symbol: SymbolCode, tick: FeedTrade): boolean {
    if (this.disposed || !this.target || this.target.symbol !== symbol) return false;
    if (!isIntraday(this.target.period) || isIndexCode(symbol)) return false;
    if (tick.qty !== 0 && tick.price > 0) {
      const day = kstDateOf(tick.t);
      this.liveDayTradedWon.set(day, (this.liveDayTradedWon.get(day) ?? 0) + Math.abs(tick.price * tick.qty));
    }
    if (!this.cvdActive) return false;
    const updated = applyLiveTradeToPoints(this.cvd.points, tick, this.target.period);
    if (!updated) return false;
    if (this.cvd.state !== "ready") this.cvd.state = "ready";
    if (this.cvd.liveLatestT === null || updated.t > this.cvd.liveLatestT) this.cvd.liveLatestT = updated.t;
    this.host.onTickCvdChanged(updated.t);
    return true;
  }

  applyLiveProgram(symbol: SymbolCode, row: FeedProgramRow): boolean {
    if (this.disposed || !this.target || !this.programActive || this.target.symbol !== symbol) return false;
    if (!isIntraday(this.target.period) || isIndexCode(symbol)) return false;
    const dayTraded = this.liveDayTradedWon.get(kstDateOf(row.t));
    const updated = applyLiveProgramToPoints(this.program.points, row, this.target.period, dayTraded);
    if (!updated) return false;
    if (this.program.state !== "ready") this.program.state = "ready";
    if (this.program.liveLatestT === null || updated.t > this.program.liveLatestT) this.program.liveLatestT = updated.t;
    this.host.onProgramChanged(updated.t);
    return true;
  }

  cvdState(): MicroFeedState {
    return this.cvd.state;
  }

  programState(): MicroFeedState {
    return this.program.state;
  }

  cvdPointAt(t: UnixSeconds): TickCvdPoint | undefined {
    return this.cvd.points.get(t);
  }

  programPointAt(t: UnixSeconds): ProgramSeriesPoint | undefined {
    return this.program.points.get(t);
  }

  cvdLiveLatestT(): UnixSeconds | null {
    return this.cvd.liveLatestT;
  }

  programLiveLatestT(): UnixSeconds | null {
    return this.program.liveLatestT;
  }

  tickCvdRow(
    config: IndicatorConfig,
    time: UnixSeconds | null,
    tokens: ThemeTokens,
    panel: IndicatorRow["panel"],
  ): IndicatorRow {
    const lines = specLines(config.spec);
    const primary = lines.length > 0 ? indicatorColorValue(tokens, lineColor(config.spec, config.style.colors, 0)) : tokens.text2;
    if (!config.visible) return { id: config.id, name: specName(config.spec), color: primary, values: [], state: "hidden", panel };
    const state = this.cvd.state;
    const pt = this.resolvePoint(this.cvd, time);
    if (state === "loading" && !pt) return { id: config.id, name: specName(config.spec), color: primary, values: [], state: "pending", panel };
    const statusText = microStateMessage(state);
    if (statusText !== null) {
      return { id: config.id, name: specName(config.spec), color: primary, values: [{ text: statusText, color: tokens.text2 }], state: "ok", panel };
    }
    const values: LegendValue[] = lines.map((lineId, i) => {
      const color = indicatorColorValue(tokens, lineColor(config.spec, config.style.colors, i));
      const text = pt ? `${LINE_LABEL[lineId]} ${formatMillionWon(tickCvdLineValue(lineId, pt))}` : `${LINE_LABEL[lineId]} —`;
      return { text, color };
    });
    return { id: config.id, name: specName(config.spec), color: primary, values, state: "ok", panel };
  }

  programFlowRow(
    config: IndicatorConfig,
    time: UnixSeconds | null,
    tokens: ThemeTokens,
    panel: IndicatorRow["panel"],
  ): IndicatorRow {
    const lines = specLines(config.spec);
    const primary = lines.length > 0 ? indicatorColorValue(tokens, lineColor(config.spec, config.style.colors, 0)) : tokens.text2;
    if (!config.visible) return { id: config.id, name: specName(config.spec), color: primary, values: [], state: "hidden", panel };
    const state = this.program.state;
    const pt = this.resolvePoint(this.program, time);
    if (state === "loading" && !pt) return { id: config.id, name: specName(config.spec), color: primary, values: [], state: "pending", panel };
    const statusText = microStateMessage(state);
    if (statusText !== null) {
      return { id: config.id, name: specName(config.spec), color: primary, values: [{ text: statusText, color: tokens.text2 }], state: "ok", panel };
    }
    const values: LegendValue[] = lines.map((lineId, i) => {
      const color = indicatorColorValue(tokens, lineColor(config.spec, config.style.colors, i));
      const formatted = pt
        ? (lineId === "programShare" ? formatSharePct(pt.programSharePct) : formatMillionWon(pt.netBuyAmountMillionWon))
        : "—";
      return { text: `${LINE_LABEL[lineId]} ${formatted}`, color };
    });
    return { id: config.id, name: specName(config.spec), color: primary, values, state: "ok", panel };
  }

  dispose(): void {
    this.disposed = true;
    resetStore(this.cvd, null, "loading");
    resetStore(this.program, null, "loading");
    this.liveDayTradedWon.clear();
  }

  private resolvePoint<P extends { t: UnixSeconds }>(store: SeriesStore<P>, time: UnixSeconds | null): P | undefined {
    if (time === null) return undefined;
    const lastBarT = this.host.bars().at(-1)?.t ?? null;
    if (lastBarT !== null && time === lastBarT && store.liveLatestT !== null && store.liveLatestT > time) {
      const livePt = store.points.get(store.liveLatestT);
      if (livePt) return livePt;
    }
    return store.points.get(time);
  }

  private coverCvd(target: MicroTarget, from: UnixSeconds, to: UnixSeconds): void {
    const store = this.cvd;
    if (store.fetching) return;
    if (store.coveredFrom !== null && from >= store.coveredFrom) return;
    const fetchTo = store.coveredFrom !== null ? store.coveredFrom : to;
    const gen = store.gen;
    const ac = new AbortController();
    store.fetching = true;
    store.abort = ac;
    this.fetchCvd(target.symbol, target.period, { from, to: fetchTo }, ac.signal).then(
      (page) => {
        if (this.disposed || gen !== store.gen) return;
        store.fetching = false;
        store.abort = null;
        const hadExisting = store.coveredFrom !== null;
        store.coveredFrom = store.coveredFrom === null ? from : Math.min(store.coveredFrom, from);
        for (const pt of page.points) {
          if (!hadExisting || !store.points.has(pt.t)) store.points.set(pt.t, pt);
        }
        if (store.points.size > 0) store.state = "ready";
        else store.state = page.state;
        this.host.onTickCvdChanged(null);
      },
      () => {
        if (this.disposed || gen !== store.gen) return;
        store.fetching = false;
        store.abort = null;
        if (store.points.size === 0 && store.state === "loading") {
          store.state = "failed";
          this.host.onTickCvdChanged(null);
        }
      },
    );
  }

  private coverProgram(target: MicroTarget, from: UnixSeconds, to: UnixSeconds): void {
    const store = this.program;
    if (store.fetching) return;
    if (store.coveredFrom !== null && from >= store.coveredFrom) return;
    const fetchTo = store.coveredFrom !== null ? store.coveredFrom : to;
    const gen = store.gen;
    const ac = new AbortController();
    store.fetching = true;
    store.abort = ac;
    this.fetchProgram(target.symbol, target.period, { from, to: fetchTo }, ac.signal).then(
      (page) => {
        if (this.disposed || gen !== store.gen) return;
        store.fetching = false;
        store.abort = null;
        const hadExisting = store.coveredFrom !== null;
        store.coveredFrom = store.coveredFrom === null ? from : Math.min(store.coveredFrom, from);
        for (const pt of page.points) {
          if (!hadExisting || !store.points.has(pt.t)) store.points.set(pt.t, pt);
        }
        if (store.points.size > 0) store.state = "ready";
        else store.state = page.state;
        this.host.onProgramChanged(null);
      },
      () => {
        if (this.disposed || gen !== store.gen) return;
        store.fetching = false;
        store.abort = null;
        if (store.points.size === 0 && store.state === "loading") {
          store.state = "failed";
          this.host.onProgramChanged(null);
        }
      },
    );
  }
}
