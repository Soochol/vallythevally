import type { IChartApi, IPaneApi, IPanePrimitive, IPrimitivePaneRenderer, IPrimitivePaneView, PaneAttachedParameter, Time } from "lightweight-charts";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { kstDay, toChartTime } from "./time";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];
type TimedBars = readonly { readonly t: UnixSeconds }[];

export interface ReplayDaysSource {
  shown(): boolean;
  bars(): TimedBars;
  days(): ReadonlySet<string> | null;
  color(): string;
}

const DAY_MS = 86_400_000;
const LINE_HEIGHT_PX = 2;
const EMPTY_RUNS: readonly [number, number][] = [];

function parseDayNumber(day: string): number | null {
  if (day.length !== 8) return null;
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(4, 6));
  const date = Number(day.slice(6, 8));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(date)) return null;
  return Math.floor(Date.UTC(year, month - 1, date) / DAY_MS);
}

function parseDayNumbers(days: ReadonlySet<string>): Set<number> {
  const dayNumbers = new Set<number>();
  for (const day of days) {
    const parsed = parseDayNumber(day);
    if (parsed !== null) dayNumbers.add(parsed);
  }
  return dayNumbers;
}

function collectedRunsForDayNumbers(bars: TimedBars, dayNumbers: ReadonlySet<number>): [number, number][] {
  if (bars.length === 0 || dayNumbers.size === 0) return [];
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < bars.length; i++) {
    const collected = dayNumbers.has(kstDay(bars[i]!.t));
    if (collected && start === -1) start = i;
    else if (!collected && start !== -1) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, bars.length - 1]);
  return runs;
}

export function collectedRuns(bars: TimedBars, days: ReadonlySet<string>): [number, number][] {
  if (bars.length === 0 || days.size === 0) return [];
  return collectedRunsForDayNumbers(bars, parseDayNumbers(days));
}

export class ReplayDays {
  private attachedPane: IPaneApi<Time> | null = null;
  private readonly primitive: PaneReplayDays;
  private cached: {
    bars: TimedBars;
    length: number;
    firstT: UnixSeconds | null;
    lastT: UnixSeconds | null;
    days: ReadonlySet<string> | null;
    dayNumbers: ReadonlySet<number>;
    runs: [number, number][];
  } = {
    bars: [],
    length: 0,
    firstT: null,
    lastT: null,
    days: null,
    dayNumbers: new Set(),
    runs: [],
  };

  constructor(private readonly chart: IChartApi, private readonly source: ReplayDaysSource) {
    this.primitive = new PaneReplayDays((target) => this.draw(target));
  }

  sync(): void {
    const pane = this.chart.panes()[0] ?? null;
    if (pane !== this.attachedPane) {
      if (this.attachedPane !== null) this.attachedPane.detachPrimitive(this.primitive);
      this.attachedPane = pane;
      if (pane !== null) pane.attachPrimitive(this.primitive);
    }
    this.primitive.redraw();
  }

  private runs(): readonly [number, number][] {
    const days = this.source.days();
    if (days === null || days.size === 0) return EMPTY_RUNS;
    const bars = this.source.bars();
    if (bars.length === 0) return EMPTY_RUNS;
    if (this.cached.bars !== bars || this.cached.days !== days) {
      const length = bars.length;
      const firstT = bars[0]!.t;
      const lastT = bars[length - 1]!.t;
      if (
        this.cached.days === days
        && length === this.cached.length
        && firstT === this.cached.firstT
        && lastT === this.cached.lastT
      ) {
        this.cached.bars = bars;
      } else if (
        this.cached.days === days
        && length === this.cached.length + 1
        && this.cached.length > 0
        && firstT === this.cached.firstT
        && bars[this.cached.length - 1]!.t === this.cached.lastT
      ) {
        if (this.cached.dayNumbers.has(kstDay(lastT))) {
          const tail = this.cached.runs[this.cached.runs.length - 1];
          if (tail && tail[1] === length - 2) tail[1] = length - 1;
          else this.cached.runs.push([length - 1, length - 1]);
        }
        this.cached.bars = bars;
        this.cached.length = length;
        this.cached.lastT = lastT;
      } else {
        const dayNumbers = this.cached.days === days ? this.cached.dayNumbers : parseDayNumbers(days);
        this.cached = {
          bars,
          length,
          firstT,
          lastT,
          days,
          dayNumbers,
          runs: collectedRunsForDayNumbers(bars, dayNumbers),
        };
      }
    }
    return this.cached.runs;
  }

  private draw(target: Target): void {
    if (!this.source.shown()) return;
    const runs = this.runs();
    if (runs.length === 0) return;
    const bars = this.source.bars();
    const scale = this.chart.timeScale();
    const width = scale.width();
    if (width <= 0) return;
    const halfBar = scale.options().barSpacing / 2;
    const color = this.source.color();

    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
      const height = Math.max(1, Math.round(LINE_HEIGHT_PX * verticalPixelRatio));
      const y = bitmapSize.height - height;
      context.save();
      context.fillStyle = color;
      for (let i = 0; i < runs.length; i++) {
        const [start, end] = runs[i]!;
        const startBar = bars[start];
        const endBar = bars[end];
        if (!startBar || !endBar) continue;
        const leftCenter = scale.timeToCoordinate(toChartTime(startBar.t));
        const rightCenter = scale.timeToCoordinate(toChartTime(endBar.t));
        if (leftCenter === null || rightCenter === null) continue;
        const left = Math.max(0, leftCenter - halfBar);
        const right = Math.min(width, rightCenter + halfBar);
        if (right <= left) continue;
        const x0 = Math.round(left * horizontalPixelRatio);
        const x1 = Math.round(right * horizontalPixelRatio);
        if (x1 > x0) context.fillRect(x0, y, x1 - x0, height);
      }
      context.restore();
    });
  }
}

class PaneReplayDays implements IPanePrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(draw: (target: Target) => void) {
    const renderer: IPrimitivePaneRenderer = { draw };
    this.views = [{ zOrder: () => "top", renderer: () => renderer }];
  }

  attached({ requestUpdate }: PaneAttachedParameter<Time>): void {
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  redraw(): void {
    this.requestUpdate?.();
  }
}
