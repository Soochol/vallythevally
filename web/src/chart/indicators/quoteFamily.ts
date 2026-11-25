import type { ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { Bar } from "../../api/generated/Bar";
import type { MicroEvent } from "../../api/generated/MicroEvent";
import type { MicroEventsPage } from "../../api/generated/MicroEventsPage";
import type { Period } from "../../api/generated/Period";
import type { QuoteDepthPage } from "../../api/generated/QuoteDepthPage";
import type { QuoteDepthPoint } from "../../api/generated/QuoteDepthPoint";
import type { QuoteTotalPoint } from "../../api/generated/QuoteTotalPoint";
import type { QuoteTotalsPage } from "../../api/generated/QuoteTotalsPage";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { fetchMicroEvents, kstYyyymmdd } from "../../api/microEvents";
import { fetchQuoteDepth, fetchQuoteTotals } from "../../api/quoteMinutes";
import { formatPrice, formatVolume } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import type { ShownVenue } from "../../lib/venue";
import { TrackedValues } from "../legendShapes";
import { QuoteFeed, type QuoteKey, type QuoteRange, type QuoteState, type QuoteView } from "../quotes/feed";
import { QuoteDepthHeatmap, type QuoteDepthLayer } from "../quotes/heatmap";
import type { IndicatorConfig } from "../settings";
import type { ThemeTokens } from "../theme";
import { isIntraday } from "../time";
import { isQuoteDepth, isQuoteTotals, specName } from "./kinds";
import type { IndicatorRow, LegendValue, PriceLegendValues } from "./layer";

export interface QuoteTarget {
  readonly symbol: SymbolCode;
  readonly venue: ShownVenue | null;
  readonly period: Period;
}

export interface QuoteFamilyDeps {
  readonly fetchQuoteTotals?: (key: QuoteKey, range: QuoteRange, signal: AbortSignal) => Promise<QuoteTotalsPage>;
  readonly fetchQuoteDepth?: (key: QuoteKey, range: QuoteRange, signal: AbortSignal) => Promise<QuoteDepthPage>;
  readonly fetchMicroEvents?: (symbol: SymbolCode, date: string, signal: AbortSignal) => Promise<MicroEventsPage>;
  readonly now?: () => UnixSeconds;
}

export interface QuoteFamilyHost {
  bars(): readonly Bar[];
  tokens(): ThemeTokens;
  configs(): readonly IndicatorConfig[];
  onTotalsChanged(view: QuoteView<QuoteTotalPoint> | null, from: UnixSeconds | null): void;
  onDepthChanged(): void;
}

interface DepthLegend {
  asks: TrackedValues;
  bids: TrackedValues;
  dirty: boolean;
  lastT: UnixSeconds | null;
}

const QUOTE_STATE_TEXT: Readonly<Partial<Record<QuoteState, string>>> = {
  disabled: "수집 폴더 미설정",
  notCollected: "수집하지 않는 종목",
  failed: "호가 자료 조회 실패",
};

export function quoteStateMessage(state: QuoteState): string | null {
  return QUOTE_STATE_TEXT[state] ?? null;
}

function thickestLevel(levels: readonly (readonly [number, number])[]): readonly [number, number] | null {
  let best: readonly [number, number] | null = null;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    if (level[1] > 0 && (best === null || level[1] > best[1])) best = level;
  }
  return best;
}

function formatDepthLevel(level: readonly [number, number] | null): string {
  return level ? `${formatPrice(level[0], false)} ${formatVolume(level[1])}` : "—";
}

function formatMicroHoverDetail(event: MicroEvent): string {
  if (event.kind === "spoof_cancel") {
    const pct = Math.round(event.ratioBps / 100);
    return `허수 취소 ${pct}% (${formatVolume(event.cancelledOrAbsorbedQty)})`;
  }
  const multiple = (event.ratioBps / 10_000).toFixed(1);
  return `아이스버그 ${multiple}x (${formatVolume(event.executedQty)})`;
}

function periodSeconds(period: Period): number {
  switch (period) {
    case "1m": return 60;
    case "3m": return 180;
    case "5m": return 300;
    case "10m": return 600;
    case "15m": return 900;
    case "30m": return 1_800;
    case "60m": return 3_600;
    default: return 60;
  }
}

const defaultNowSeconds = (): UnixSeconds => Math.floor(Date.now() / 1000);

export class QuoteIndicatorController {
  private readonly totalsFeed: QuoteFeed<QuoteTotalPoint>;
  private readonly depthFeeds = new Map<string, QuoteFeed<QuoteDepthPoint>>();
  private readonly fetchDepth: (key: QuoteKey, range: QuoteRange, signal: AbortSignal) => Promise<QuoteDepthPage>;
  private readonly loadMicroEvents: (symbol: SymbolCode, date: string, signal: AbortSignal) => Promise<MicroEventsPage>;
  private readonly now: () => UnixSeconds;
  private readonly heatmap: QuoteDepthHeatmap;
  private readonly depthLegends = new Map<string, DepthLegend>();
  private mainSeries: ISeriesApi<SeriesType, Time> | null = null;
  private target: QuoteTarget | null = null;
  private totalsOverride: QuoteView<QuoteTotalPoint> | null | undefined = undefined;
  private depthOverrides: ReadonlyMap<string, QuoteView<QuoteDepthPoint>> | null = null;
  private totalsActive = false;
  private microKey: string | null = null;
  private microAbort: AbortController | null = null;
  private microEvents: readonly MicroEvent[] = [];
  private disposed = false;

  constructor(private readonly host: QuoteFamilyHost, deps: QuoteFamilyDeps = {}) {
    this.now = deps.now ?? defaultNowSeconds;
    this.fetchDepth = deps.fetchQuoteDepth ?? fetchQuoteDepth;
    this.loadMicroEvents = deps.fetchMicroEvents ?? fetchMicroEvents;
    this.totalsFeed = new QuoteFeed<QuoteTotalPoint>({
      fetch: deps.fetchQuoteTotals ?? fetchQuoteTotals,
      changed: (from) => {
        if (this.disposed) return;
        this.totalsOverride = undefined;
        this.host.onTotalsChanged(this.totalsActive ? this.totalsFeed : null, from);
      },
      now: this.now,
    });
    this.heatmap = new QuoteDepthHeatmap({
      bars: () => this.host.bars(),
      tokens: () => this.host.tokens(),
      layers: () => this.depthLayers(),
    });
  }

  attachMainSeries(series: ISeriesApi<SeriesType, Time>): void {
    if (this.mainSeries === series) return;
    if (this.mainSeries !== null) this.mainSeries.detachPrimitive(this.heatmap);
    this.mainSeries = series;
    series.attachPrimitive(this.heatmap);
  }

  detachMainSeries(series: ISeriesApi<SeriesType, Time>): void {
    if (this.mainSeries === series) this.mainSeries = null;
    series.detachPrimitive(this.heatmap);
  }

  setTarget(target: QuoteTarget | null, sync = true): void {
    this.target = target;
    if (sync) this.syncFeeds();
  }

  syncFeeds(): void {
    const target = this.target;
    const configs = this.host.configs();
    const eligible = target !== null && target.venue !== null && !isIndexCode(target.symbol) && isIntraday(target.period);

    const totalsWanted = eligible && configs.some((c) => isQuoteTotals(c.spec) && c.visible);
    this.totalsActive = totalsWanted;
    if (!totalsWanted) {
      this.totalsFeed.open(null);
      if (this.totalsOverride === undefined) this.host.onTotalsChanged(null, null);
    } else {
      this.totalsOverride = undefined;
      this.totalsFeed.open({ symbol: target.symbol, venue: target.venue!, period: target.period });
      this.host.onTotalsChanged(this.totalsFeed, null);
    }

    const activeDepth = eligible ? configs.filter((c) => isQuoteDepth(c.spec) && c.visible) : [];
    const activeIds = new Set(activeDepth.map((c) => c.id));
    for (const [id, feed] of this.depthFeeds) {
      if (activeIds.has(id)) continue;
      feed.dispose();
      this.depthFeeds.delete(id);
    }
    for (const config of activeDepth) {
      if (!isQuoteDepth(config.spec)) continue;
      let feed = this.depthFeeds.get(config.id);
      if (!feed) {
        feed = new QuoteFeed<QuoteDepthPoint>({
          fetch: this.fetchDepth,
          changed: () => {
            if (this.disposed) return;
            this.depthOverrides = null;
            this.markDepthLegendsDirty();
            this.heatmap.redraw();
            this.host.onDepthChanged();
          },
          now: this.now,
        });
        this.depthFeeds.set(config.id, feed);
      }
      this.depthOverrides = null;
      feed.open({ symbol: target!.symbol, venue: target!.venue!, period: target!.period, variant: config.spec.source });
    }
    const microWanted = activeDepth.some((c) => isQuoteDepth(c.spec) && (c.spec.showSpoof === true || c.spec.showIceberg === true));
    this.syncMicroEvents(microWanted && target !== null ? target.symbol : null);
    this.cover(this.host.bars());
    this.heatmap.redraw();
  }

  cover(bars: readonly Bar[]): void {
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (!first || !last) return;
    if (this.totalsActive) this.totalsFeed.cover(first.t, last.t);
    for (const feed of this.depthFeeds.values()) feed.cover(first.t, last.t);
  }

  redrawHeatmap(): void {
    this.heatmap.redraw();
  }

  setTotalsOverride(view: QuoteView<QuoteTotalPoint> | null): void {
    this.totalsOverride = view;
  }

  setDepthOverrides(views: ReadonlyMap<string, QuoteView<QuoteDepthPoint>>): void {
    this.depthOverrides = views;
    this.markDepthLegendsDirty();
    this.heatmap.redraw();
  }

  totalsView(): QuoteView<QuoteTotalPoint> | null {
    if (this.totalsOverride !== undefined) return this.totalsOverride;
    return this.totalsActive ? this.totalsFeed : null;
  }

  depthView(id: string): QuoteView<QuoteDepthPoint> | undefined {
    if (this.depthOverrides !== null) return this.depthOverrides.get(id);
    return this.depthFeeds.get(id);
  }

  totalsRow(
    config: IndicatorConfig,
    time: UnixSeconds | null,
    tokens: ThemeTokens,
    panel: IndicatorRow["panel"],
  ): IndicatorRow {
    if (!config.visible) return { id: config.id, name: specName(config.spec), color: tokens.down, values: [], state: "hidden", panel };
    const view = this.totalsView();
    const pt = time !== null && view ? view.at(time) : undefined;
    const qState = view?.state ?? "loading";
    if (qState === "loading" && !pt) return { id: config.id, name: specName(config.spec), color: tokens.down, values: [], state: "pending", panel };
    const statusText = quoteStateMessage(qState);
    const values: LegendValue[] = statusText !== null
      ? [{ text: statusText, color: tokens.text2 }]
      : pt
        ? [{ text: formatVolume(pt.ask), color: tokens.down }, { text: formatVolume(pt.bid), color: tokens.up }]
        : [{ text: "—", color: tokens.down }, { text: "—", color: tokens.up }];
    return { id: config.id, name: specName(config.spec), color: tokens.down, values, state: "ok", panel };
  }

  depthRow(config: IndicatorConfig, time: UnixSeconds | null, tokens: ThemeTokens): IndicatorRow {
    if (!isQuoteDepth(config.spec)) {
      return { id: config.id, name: specName(config.spec), color: tokens.down, values: [], state: "hidden", panel: null };
    }
    const askColor = config.spec.askColor ?? tokens.down;
    const bidColor = config.spec.bidColor ?? tokens.up;
    if (!config.visible) return { id: config.id, name: specName(config.spec), color: askColor, values: [], state: "hidden", panel: null };
    const view = this.depthView(config.id);
    const pt = time !== null && view ? view.at(time) : undefined;
    const qState = view?.state ?? "loading";
    if (qState === "loading" && !pt) return { id: config.id, name: specName(config.spec), color: askColor, values: [], state: "pending", panel: null };
    const statusText = quoteStateMessage(qState);
    const values: LegendValue[] = statusText !== null
      ? [{ text: statusText, color: tokens.text2 }]
      : pt
        ? [{ text: formatDepthLevel(thickestLevel(pt.asks)), color: askColor }, { text: formatDepthLevel(thickestLevel(pt.bids)), color: bidColor }]
        : [{ text: "—", color: askColor }, { text: "—", color: bidColor }];
    const showSpoof = config.spec.showSpoof === true;
    const showIceberg = config.spec.showIceberg === true;
    if (time !== null && (showSpoof || showIceberg)) {
      const span = this.target ? periodSeconds(this.target.period) : 60;
      const hit = this.microEvents.find((event) => {
        if (event.kind === "spoof_cancel" && !showSpoof) return false;
        if (event.kind === "iceberg_absorb" && !showIceberg) return false;
        const sec = Math.floor(event.recvMs / 1000);
        return sec >= time && sec < time + span;
      });
      if (hit) {
        values.push({
          text: formatMicroHoverDetail(hit),
          color: hit.kind === "spoof_cancel" ? tokens.ind?.["ind-1"] ?? askColor : tokens.accent ?? bidColor,
        });
      }
    }
    return { id: config.id, name: specName(config.spec), color: askColor, values, state: "ok", panel: null };
  }

  depthPriceLegend(config: IndicatorConfig, display: readonly Bar[]): PriceLegendValues {
    if (!config.visible) return { id: config.id, slots: [] };
    const view = this.depthView(config.id);
    const qState = view?.state ?? "loading";
    const statusText = quoteStateMessage(qState);
    if (statusText !== null) return { id: config.id, slots: [[statusText]] };
    if (qState === "loading") return { id: config.id, slots: [] };
    const legend = this.depthLegend(config.id);
    if (legend.dirty) this.rebuildDepthLegend(legend, view, display);
    return { id: config.id, slots: [legend.asks.values, legend.bids.values] };
  }

  markDepthLegendsDirty(): void {
    for (const legend of this.depthLegends.values()) legend.dirty = true;
  }

  clearDepthLegends(): void {
    for (const legend of this.depthLegends.values()) {
      legend.asks.clear();
      legend.bids.clear();
      legend.lastT = null;
      legend.dirty = true;
    }
  }

  removeDepthLegend(id: string): void {
    this.depthLegends.delete(id);
  }

  advanceDepthLegends(configs: readonly IndicatorConfig[], bar: Bar): void {
    for (const config of configs) {
      if (!config.visible || !isQuoteDepth(config.spec)) continue;
      const legend = this.depthLegends.get(config.id);
      if (!legend || legend.dirty) continue;
      const view = this.depthView(config.id);
      if (!view || view.state !== "ready") continue;
      const pt = view.at(bar.t);
      const ask = formatDepthLevel(pt ? thickestLevel(pt.asks) : null);
      const bid = formatDepthLevel(pt ? thickestLevel(pt.bids) : null);
      if (legend.lastT === bar.t && legend.asks.values.length > 0) {
        legend.asks.setAt(legend.asks.values.length - 1, ask);
        legend.bids.setAt(legend.bids.values.length - 1, bid);
      } else if (legend.lastT === null || bar.t > legend.lastT) {
        legend.asks.push(ask);
        legend.bids.push(bid);
        legend.lastT = bar.t;
      } else {
        legend.dirty = true;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.microAbort?.abort();
    this.microAbort = null;
    this.microKey = null;
    this.microEvents = [];
    if (this.mainSeries !== null) {
      this.mainSeries.detachPrimitive(this.heatmap);
      this.mainSeries = null;
    }
    this.totalsFeed.dispose();
    for (const feed of this.depthFeeds.values()) feed.dispose();
    this.depthFeeds.clear();
    this.depthLegends.clear();
  }

  private syncMicroEvents(symbol: SymbolCode | null): void {
    if (symbol === null) {
      this.microAbort?.abort();
      this.microAbort = null;
      this.microKey = null;
      this.microEvents = [];
      return;
    }
    const date = kstYyyymmdd(this.now() * 1000);
    const key = `${symbol}:${date}`;
    if (this.microKey === key) return;
    this.microAbort?.abort();
    this.microKey = key;
    this.microEvents = [];
    const abort = new AbortController();
    this.microAbort = abort;
    this.loadMicroEvents(symbol, date, abort.signal).then(
      (page) => {
        if (this.disposed || abort.signal.aborted || this.microKey !== key) return;
        this.microEvents = page.events;
        this.heatmap.redraw();
        this.host.onDepthChanged();
      },
      () => {},
    );
  }

  private depthLayers(): QuoteDepthLayer[] {
    const out: QuoteDepthLayer[] = [];
    for (const config of this.host.configs()) {
      if (!config.visible || !isQuoteDepth(config.spec)) continue;
      const view = this.depthView(config.id);
      if (view) {
        const showMicro = config.spec.showSpoof === true || config.spec.showIceberg === true;
        out.push({ spec: config.spec, view, microEvents: showMicro ? this.microEvents : undefined });
      }
    }
    return out;
  }

  private depthLegend(id: string): DepthLegend {
    let legend = this.depthLegends.get(id);
    if (!legend) {
      legend = { asks: new TrackedValues(), bids: new TrackedValues(), dirty: true, lastT: null };
      this.depthLegends.set(id, legend);
    }
    return legend;
  }

  private rebuildDepthLegend(legend: DepthLegend, view: QuoteView<QuoteDepthPoint> | undefined, display: readonly Bar[]): void {
    const asks: string[] = [];
    const bids: string[] = [];
    for (let i = 0; i < display.length; i++) {
      const pt = view?.at(display[i]!.t);
      asks.push(formatDepthLevel(pt ? thickestLevel(pt.asks) : null));
      bids.push(formatDepthLevel(pt ? thickestLevel(pt.bids) : null));
    }
    if (asks.length === 0) {
      asks.push("—");
      bids.push("—");
    }
    legend.asks.syncAll(asks);
    legend.bids.syncAll(bids);
    legend.lastT = display.at(-1)?.t ?? null;
    legend.dirty = false;
  }
}
