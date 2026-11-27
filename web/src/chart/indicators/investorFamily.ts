import type { Bar } from "../../api/generated/Bar";
import type { DayHistory } from "../../api/generated/DayHistory";
import type { InvestorNetSharesDay } from "../../api/generated/InvestorNetSharesDay";
import type { KstDate } from "../../api/generated/KstDate";
import type { Period } from "../../api/generated/Period";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { fetchInvestorNetShares } from "../../api/investors";
import { isIndexCode } from "../../lib/symbol";
import { kstDateOf } from "../barJump";
import { type DateRange, mergeRanges, missingUnchunked } from "../quotes/coverage";
import type { IndicatorConfig } from "../settings";
import { indicatorColorValue, type ThemeTokens } from "../theme";
import { isIntraday } from "../time";
import {
  bucketInclusiveEndDate,
  buildInvestorSeries,
  formatFlowValue,
  type InvestorFlowSeriesData,
  type InvestorParty,
} from "./flowSeries";
import {
  colorLine,
  isForeignFlow,
  isInvestorFlow,
  type InvestorFlowSpec,
  LINE_LABEL,
  lineColor,
  specLines,
  specName,
} from "./kinds";
import type { IndicatorRow, LegendValue } from "./layer";

export type InvestorFeedState = "loading" | "ready" | "unsupported" | "failed";

const INVESTOR_STATE_TEXT: Readonly<Partial<Record<InvestorFeedState, string>>> = {
  unsupported: "주식·ETF 일봉 이상 전용",
  failed: "투자자 수급 조회 실패",
};

export function investorStateMessage(state: InvestorFeedState): string | null {
  return INVESTOR_STATE_TEXT[state] ?? null;
}

export interface InvestorTarget {
  readonly symbol: SymbolCode;
  readonly period: Period;
}

export interface InvestorFamilyDeps {
  readonly fetchInvestorNetShares?: (
    symbol: SymbolCode,
    from: KstDate,
    to: KstDate,
    signal: AbortSignal,
  ) => Promise<DayHistory<InvestorNetSharesDay>>;
}

export interface InvestorFamilyHost {
  bars(): readonly Bar[];
  tokens(): ThemeTokens;
  configs(): readonly IndicatorConfig[];
  onInvestorChanged(): void;
}

function expandNeed(prev: DateRange | null, next: DateRange): DateRange {
  if (!prev) return next;
  return {
    from: prev.from < next.from ? prev.from : next.from,
    to: prev.to > next.to ? prev.to : next.to,
  };
}

interface SeriesCacheEntry {
  readonly rev: number;
  readonly bars: readonly Bar[];
  readonly period: Period;
  readonly spec: InvestorFlowSpec;
  readonly data: InvestorFlowSeriesData;
}

export class InvestorFlowController {
  private readonly fetchHistory: (
    symbol: SymbolCode,
    from: KstDate,
    to: KstDate,
    signal: AbortSignal,
  ) => Promise<DayHistory<InvestorNetSharesDay>>;
  private readonly daysByDate = new Map<KstDate, InvestorNetSharesDay>();
  private readonly estimatedDays = new Set<KstDate>();
  private readonly seriesCache = new Map<string, SeriesCacheEntry>();
  private target: InvestorTarget | null = null;
  private cacheSymbol: SymbolCode | null = null;
  private active = false;
  private state: InvestorFeedState = "loading";
  private have: DateRange[] = [];
  private need: DateRange | null = null;
  private gen = 0;
  private rev = 0;
  private fetching = false;
  private abort: AbortController | null = null;
  private disposed = false;

  constructor(private readonly host: InvestorFamilyHost, deps: InvestorFamilyDeps = {}) {
    this.fetchHistory = deps.fetchInvestorNetShares ?? fetchInvestorNetShares;
  }

  setTarget(target: InvestorTarget | null, sync = true): void {
    this.target = target;
    if (sync) this.syncFeeds();
  }

  invalidateCoverage(): void {
    if (!this.active || this.cacheSymbol === null) return;
    this.resetStore(this.cacheSymbol, "loading");
  }

  syncFeeds(): void {
    const target = this.target;
    const configs = this.host.configs();
    const hasInvestor = configs.some((c) => isInvestorFlow(c.spec) && c.visible);
    const eligible = target !== null && !isIndexCode(target.symbol) && !isIntraday(target.period);

    this.active = eligible && hasInvestor;
    if (!hasInvestor) {
      if (this.cacheSymbol !== null || this.daysByDate.size > 0) {
        this.resetStore(null, "loading");
      }
      return;
    }

    if (!eligible) {
      if (this.state !== "unsupported" || this.cacheSymbol !== null) {
        this.resetStore(null, "unsupported");
        this.host.onInvestorChanged();
      }
      return;
    }

    if (this.cacheSymbol !== target.symbol || this.state === "unsupported") {
      this.resetStore(target.symbol, "loading");
      this.host.onInvestorChanged();
    }

    this.cover(this.host.bars());
  }

  cover(bars: readonly Bar[]): void {
    if (this.disposed || !this.active || !this.target) return;
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (!first || !last) return;
    const fromDate = kstDateOf(first.t);
    const toDate = bucketInclusiveEndDate(last.t, this.target.period);
    const range: DateRange = fromDate <= toDate ? { from: fromDate, to: toDate } : { from: toDate, to: fromDate };
    this.need = expandNeed(this.need, range);
    this.pump(this.target.symbol);
  }

  feedState(): InvestorFeedState {
    return this.state;
  }

  seriesFor(config: IndicatorConfig): InvestorFlowSeriesData {
    if (!isInvestorFlow(config.spec)) {
      return { bar: [], line: [], cum: [], byTime: new Map() };
    }
    const bars = this.host.bars();
    const period = this.target?.period ?? "D";
    const cached = this.seriesCache.get(config.id);
    if (
      cached
      && cached.rev === this.rev
      && cached.bars === bars
      && cached.period === period
      && cached.spec === config.spec
    ) {
      return cached.data;
    }
    const party: InvestorParty = isForeignFlow(config.spec) ? "foreign" : "institution";
    const data = buildInvestorSeries(bars, period, this.daysByDate, this.estimatedDays, party, config.spec);
    this.seriesCache.set(config.id, { rev: this.rev, bars, period, spec: config.spec, data });
    return data;
  }

  row(
    config: IndicatorConfig,
    time: UnixSeconds | null,
    tokens: ThemeTokens,
    panel: IndicatorRow["panel"],
  ): IndicatorRow {
    if (!isInvestorFlow(config.spec)) {
      return { id: config.id, name: specName(config.spec), color: tokens.text2, values: [], state: "ok", panel };
    }
    const spec = config.spec;
    const lines = specLines(spec);
    const primaryIdx = colorLine(spec);
    const primary = primaryIdx !== null
      ? indicatorColorValue(tokens, lineColor(spec, config.style.colors, primaryIdx))
      : tokens.text2;
    if (!config.visible) {
      return { id: config.id, name: specName(spec), color: primary, values: [], state: "hidden", panel };
    }
    const statusText = investorStateMessage(this.state);
    if (statusText !== null) {
      return {
        id: config.id,
        name: specName(spec),
        color: primary,
        values: [{ text: statusText, color: tokens.text2 }],
        state: "ok",
        panel,
      };
    }
    const series = this.seriesFor(config);
    const entry = time !== null ? series.byTime.get(time) : undefined;
    if (this.state === "loading" && !entry) {
      return { id: config.id, name: specName(spec), color: primary, values: [], state: "pending", panel };
    }
    const values: LegendValue[] = lines.map((lineId, i) => {
      if (lineId === "flowBar") {
        const val = entry
          ? (spec.displayMode === "both" ? entry.bar : spec.aggregation === "cumulative" ? entry.cum : entry.bar)
          : null;
        const color = val === null || val === 0 ? tokens.text2 : val > 0 ? tokens.up : tokens.down;
        return { text: `${LINE_LABEL[lineId]} ${val === null ? "—" : formatFlowValue(val, spec.unit)}`, color };
      }
      const color = indicatorColorValue(tokens, lineColor(spec, config.style.colors, i));
      const val = !entry
        ? null
        : lineId === "flowCum"
          ? entry.cum
          : spec.aggregation === "cumulative"
            ? entry.cum
            : entry.bar;
      return { text: `${LINE_LABEL[lineId]} ${val === null ? "—" : formatFlowValue(val, spec.unit)}`, color };
    });
    if (entry?.estimated) {
      values.push({ text: "추정", color: tokens.text3 });
    }
    return { id: config.id, name: specName(spec), color: primary, values, state: "ok", panel };
  }

  dispose(): void {
    this.disposed = true;
    this.resetStore(null, "loading");
  }

  private resetStore(symbol: SymbolCode | null, state: InvestorFeedState): void {
    this.gen++;
    this.rev++;
    this.abort?.abort();
    this.abort = null;
    this.fetching = false;
    this.cacheSymbol = symbol;
    this.state = state;
    this.daysByDate.clear();
    this.estimatedDays.clear();
    this.seriesCache.clear();
    this.have = [];
    this.need = null;
  }

  private pump(symbol: SymbolCode): void {
    if (this.disposed || !this.active || this.fetching || !this.need) return;
    const gaps = missingUnchunked(this.need, this.have);
    if (gaps.length === 0) return;
    const gap = gaps[0]!;
    const gen = this.gen;
    const ac = new AbortController();
    this.fetching = true;
    this.abort = ac;
    this.fetchHistory(symbol, gap.from, gap.to, ac.signal).then(
      (page) => {
        if (this.disposed || gen !== this.gen) return;
        this.fetching = false;
        this.abort = null;
        this.have = mergeRanges(this.have, gap);
        for (const day of page.days) {
          this.daysByDate.set(day.day, day);
        }
        for (const est of page.estimatedDays ?? []) {
          this.estimatedDays.add(est);
        }
        this.rev++;
        this.state = "ready";
        this.host.onInvestorChanged();
        this.pump(symbol);
      },
      () => {
        if (this.disposed || gen !== this.gen) return;
        this.fetching = false;
        this.abort = null;
        if (this.daysByDate.size === 0 && this.state === "loading") {
          this.state = "failed";
          this.host.onInvestorChanged();
        }
      },
    );
  }
}
