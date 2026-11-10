import { type IChartApi, type ISeriesApi, LineSeries, type LineData, type UTCTimestamp } from "lightweight-charts";
import type { SeriesKey } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import type { Venue } from "../api/generated/Venue";
import type { MarketSocketLike } from "../api/socket";
import { type Direction, direction, formatPercent } from "../lib/format";
import { isIndexCode } from "../lib/symbol";
import type { ShownVenue } from "../lib/venue";
import { BarFeed, displayBars, type FetchPage, type History } from "./barFeed";
import { priceFormat } from "./series";
import type { ThemeTokens } from "./theme";
import { toChartTime } from "./time";

/** 덮기 시도 한 번에 비교 종목 하나가 잇는 과거 페이지 상한. 키움 조회 비용 때문이다(#76). */
export const MAX_COVER_PAGES = 20;

export const COMPARE_NOTE = { missing: "찾을 수 없음", failed: "받지 못함", limited: "실시간 아님", base: "% 기준: 첫 받은 봉" } as const;

export type CompareSlot = 1 | 2 | 3;

export interface CompareEntry {
  code: SymbolCode;
  /** 저장 목록의 자리. 색(`--cmp-n`)을 정한다. */
  slot: CompareSlot;
  name: string;
}

export interface CompareKey {
  period: Period;
  venueFor(code: SymbolCode): Venue | null;
}

export interface CompareRow {
  code: SymbolCode;
  name: string;
  color: string;
  value: string;
  dir: Direction;
  notes: string[];
  /** 최신 페이지를 받지 못해 선이 없다. 범례 줄을 흐리게 한다. */
  failed: boolean;
  last: Bar | null;
}

export interface CompareHost {
  chart: IChartApi;
  tokens(): ThemeTokens;
  /** 주 시리즈의 봉(t 오름차순). 비교 시리즈는 이 시각에만 점을 둔다. */
  mainBars(): readonly Bar[];
  requestFrame(): void;
  guard(draw: () => void): void;
}

/** 지수는 거래소가 없다. 주식은 주 종목과 시간대가 맞는 거래소를 쓴다. */
export function compareVenue(code: SymbolCode, main: { symbol: SymbolCode; venue: ShownVenue | null }): Venue | null {
  if (isIndexCode(code)) return null;
  return main.venue === "krx" || isIndexCode(main.symbol) ? "krx" : "combined";
}

/** 주 봉에 있는 시각의 비교 봉만 남긴다. 시간축은 모든 시리즈 시각의 합집합이라, 남은 봉이 주 봉의 번호를 바꾸면 안 된다. */
export function alignToMain(bars: readonly Bar[], main: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let j = 0;
  for (const b of bars) {
    while (j < main.length && main[j]!.t < b.t) j++;
    if (j === main.length) break;
    if (main[j]!.t === b.t) out.push(b);
  }
  return out;
}

function atOrAfter(xs: readonly Bar[], t: UnixSeconds): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const hasTime = (xs: readonly Bar[], t: UnixSeconds) => xs[atOrAfter(xs, t)]?.t === t;

function atOrBefore(xs: readonly Bar[], t: UnixSeconds): number {
  const i = atOrAfter(xs, t);
  return xs[i]?.t === t ? i : i - 1;
}

const firstT = (h: History | null): UnixSeconds | null => (h ? (h.bars[0] ?? h.current)?.t ?? null : null);

const point = (b: Bar): LineData<UTCTimestamp> => ({ time: toChartTime(b.t), value: b.c });

const sameKey = (a: SeriesKey, b: SeriesKey) => a.symbol === b.symbol && a.venue === b.venue && a.period === b.period;

class CompareLine {
  history: History | null = null;
  status: "loading" | "ok" | "failed" | "missing" = "loading";
  limited = false;
  /** 시리즈에 그린 봉. 주 봉에 맞춘 것이다. */
  points: Bar[] = [];
  /** 다음 그리기에서 맞추기부터 다시 한다. */
  stale = false;
  older: "idle" | "loading" | "failed" = "idle";
  pages = 0;
  stoppedAt: UnixSeconds | null = null;
  readonly feed: BarFeed;

  constructor(
    public entry: CompareEntry,
    public key: SeriesKey,
    readonly series: ISeriesApi<"Line">,
    fetchPage: FetchPage,
    socket: Pick<MarketSocketLike, "subscribe"> | undefined,
    changed: (line: CompareLine) => void,
  ) {
    this.feed = new BarFeed(
      fetchPage,
      {
        reset: (h) => {
          this.history = h;
          this.status = "ok";
          this.restartCover();
          this.stale = true;
          changed(this);
        },
        prepended: (h, added) => {
          this.history = h;
          this.older = "idle";
          if (added > 0) this.stale = true;
          changed(this);
        },
        failed: (e) => {
          this.history = null;
          this.status = e.code === "unknown_symbol" ? "missing" : "failed";
          this.restartCover();
          this.stale = true;
          changed(this);
        },
        olderFailed: () => {
          this.older = "failed";
          changed(this);
        },
        live: (h) => {
          this.history = h;
          changed(this);
        },
        confirmed: (h) => {
          this.history = h;
          changed(this);
        },
        subError: (code) => {
          this.limited = code !== null;
          changed(this);
        },
      },
      socket,
    );
    this.feed.open(key);
  }

  reopen(key: SeriesKey): void {
    this.key = key;
    this.history = null;
    this.status = "loading";
    this.limited = false;
    this.restartCover();
    this.stale = true;
    this.feed.open(key);
  }

  private restartCover(): void {
    this.older = "idle";
    this.pages = 0;
    this.stoppedAt = null;
  }
}

/**
 * 칸의 비교 종목(최대 3개, frontend.md §3.4). 종목마다 구독과 봉 받기를 따로 하고, 가격 패널에 선 하나를 그린다.
 * 주 봉의 주인은 컨트롤러다. 이 층은 읽기만 하고, 비교 시리즈에는 주 봉에 있는 시각만 둔다.
 * 그리기는 주 시리즈가 `this.bars`와 같아지는 두 때에만 한다: `realign`(주 시리즈 setData 직후)과 `flush`(대기 봉을 그린 뒤).
 */
export class CompareLayer {
  private readonly lines = new Map<SymbolCode, CompareLine>();
  private leftT: UnixSeconds | null = null;

  constructor(
    private readonly host: CompareHost,
    private readonly fetchPage: FetchPage,
    private readonly socket?: Pick<MarketSocketLike, "subscribe">,
  ) {}

  setCodes(entries: readonly CompareEntry[], key: CompareKey): void {
    const keep = new Set(entries.map((e) => e.code));
    this.host.guard(() => {
      for (const [code, line] of this.lines) if (!keep.has(code)) this.remove(line);
      for (const entry of entries) {
        const want: SeriesKey = { symbol: entry.code, venue: key.venueFor(entry.code), period: key.period };
        const line = this.lines.get(entry.code);
        if (!line) {
          this.lines.set(entry.code, this.add(entry, want));
          continue;
        }
        const recolor = line.entry.slot !== entry.slot;
        line.entry = entry;
        if (recolor) line.series.applyOptions({ color: this.color(entry.slot) });
        if (!sameKey(line.key, want)) {
          line.reopen(want);
          this.redraw(line);
        }
      }
    });
    this.host.requestFrame();
  }

  /** 주 시리즈의 데이터를 통째로 바꿨다(비우기 포함). 같은 가드 안에서 부른다. */
  realign(): void {
    if (this.lines.size === 0) return;
    this.host.guard(() => {
      for (const line of this.lines.values()) this.redraw(line);
    });
  }

  /** 주 시리즈의 대기 봉을 그린 뒤 같은 프레임에서 부른다. */
  flush(): void {
    if (this.lines.size === 0) return;
    this.host.guard(() => {
      for (const line of this.lines.values()) this.drawTail(line);
    });
  }

  /** 보이는 왼쪽 끝 봉의 시각. 비교 종목의 첫 봉이 그보다 늦으면 과거 페이지를 잇는다. */
  coverFrom(leftT: UnixSeconds | null): void {
    this.leftT = leftT;
    for (const line of this.lines.values()) this.cover(line);
  }

  /** 칸의 `다시 시도`. 최신 페이지를 받지 못한 비교 종목만 다시 받는다. */
  reload(): void {
    for (const line of this.lines.values()) if (line.status === "failed" || line.status === "missing") line.feed.reload();
  }

  rows(leftT: UnixSeconds | null, hoverT: UnixSeconds | null): CompareRow[] {
    const tokens = this.host.tokens();
    return [...this.lines.values()]
      .sort((a, b) => a.entry.slot - b.entry.slot)
      .map((line) => {
        const pts = line.points;
        const base = leftT === null ? undefined : pts[atOrAfter(pts, leftT)];
        const at = hoverT === null ? undefined : pts[atOrBefore(pts, hoverT)];
        const pct = base && at && at.t >= base.t ? (at.c / base.c - 1) * 100 : null;
        const first = firstT(line.history);
        const notes: string[] = [];
        if (line.status === "failed" || line.status === "missing") notes.push(COMPARE_NOTE[line.status]);
        if (line.limited) notes.push(COMPARE_NOTE.limited);
        if (leftT !== null && first !== null && first > leftT && line.older !== "loading") notes.push(COMPARE_NOTE.base);
        return {
          code: line.entry.code,
          name: line.entry.name,
          color: tokens.cmp[line.entry.slot],
          value: pct === null ? "—" : formatPercent(pct),
          dir: pct === null ? "flat" : direction(pct),
          notes,
          failed: line.status === "failed" || line.status === "missing",
          last: pts[pts.length - 1] ?? null,
        };
      });
  }

  setTheme(): void {
    for (const line of this.lines.values()) line.series.applyOptions({ color: this.color(line.entry.slot) });
  }

  dispose(): void {
    for (const line of [...this.lines.values()]) this.remove(line);
  }

  private add(entry: CompareEntry, key: SeriesKey): CompareLine {
    const series = this.host.chart.addSeries(
      LineSeries,
      {
        color: this.color(entry.slot),
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
        priceFormat: priceFormat(isIndexCode(entry.code)),
        title: "",
      },
      0,
    );
    return new CompareLine(entry, key, series, this.fetchPage, this.socket, (line) => this.changed(line));
  }

  private remove(line: CompareLine): void {
    line.feed.dispose();
    this.lines.delete(line.entry.code);
    this.host.guard(() => this.host.chart.removeSeries(line.series));
  }

  private changed(line: CompareLine): void {
    if (this.lines.get(line.entry.code) !== line) return;
    this.cover(line);
    this.host.requestFrame();
  }

  private color(slot: CompareSlot): string {
    return this.host.tokens().cmp[slot];
  }

  private cover(line: CompareLine): void {
    const left = this.leftT;
    const h = line.history;
    const first = firstT(h);
    if (left === null || !h || first === null || line.older !== "idle") return;
    if (first <= left || h.nextBefore === null) {
      line.pages = 0;
      line.stoppedAt = null;
      return;
    }
    if (line.stoppedAt !== null) {
      if (line.stoppedAt === left) return;
      line.stoppedAt = null;
      line.pages = 0;
    }
    if (line.pages >= MAX_COVER_PAGES) {
      line.stoppedAt = left;
      return;
    }
    line.pages++;
    line.older = "loading";
    line.feed.needOlder();
  }

  private redraw(line: CompareLine): void {
    line.stale = false;
    line.points = line.history ? alignToMain(displayBars(line.history), this.host.mainBars()) : [];
    line.series.setData(line.points.map(point));
  }

  private drawTail(line: CompareLine): void {
    const last = line.points[line.points.length - 1];
    if (line.stale || (!last && line.history)) return this.redraw(line);
    if (!last || !line.history) return;
    const main = this.host.mainBars();
    const bars = displayBars(line.history);
    for (let i = atOrAfter(bars, last.t); i < bars.length; i++) {
      const b = bars[i]!;
      const end = line.points[line.points.length - 1]!;
      if (b === end || !hasTime(main, b.t)) continue;
      try {
        line.series.update(point(b));
      } catch (e) {
        console.error(`비교 종목 선(${line.entry.code})을 다시 그림: ${e instanceof Error ? e.message : String(e)}`);
        return this.redraw(line);
      }
      if (b.t === end.t) line.points[line.points.length - 1] = b;
      else line.points.push(b);
    }
  }
}
