import type { IChartApi, IPaneApi, IPanePrimitive, IPrimitivePaneRenderer, IPrimitivePaneView, PaneAttachedParameter, Time } from "lightweight-charts";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { kstDateChanges, toChartTime } from "./time";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];
type TimedBars = readonly { t: UnixSeconds }[];

export interface DaySeparatorSource {
  shown(): boolean;
  bars(): TimedBars;
  color(): string;
}

const DASH_PX = [1, 3];

export class DaySeparators {
  private readonly attached = new Map<IPaneApi<Time>, PaneSeparators>();
  private starts: { bars: TimedBars; indices: number[] } = { bars: [], indices: [] };

  constructor(private readonly chart: IChartApi, private readonly source: DaySeparatorSource) {}

  sync(): void {
    const panes = this.chart.panes();
    for (const pane of this.attached.keys()) if (!panes.includes(pane)) this.attached.delete(pane);
    for (const pane of panes) {
      if (this.attached.has(pane)) continue;
      const separators = new PaneSeparators(() => this.xs(), () => this.source.color());
      pane.attachPrimitive(separators);
      this.attached.set(pane, separators);
    }
    this.attached.forEach((separators) => separators.redraw());
  }

  private xs(): number[] {
    if (!this.source.shown()) return [];
    const bars = this.source.bars();
    if (this.starts.bars !== bars) this.starts = { bars, indices: kstDateChanges(bars) };
    const scale = this.chart.timeScale();
    const width = scale.width();
    return this.starts.indices.flatMap((i) => {
      const before = scale.timeToCoordinate(toChartTime(bars[i - 1]!.t));
      const after = scale.timeToCoordinate(toChartTime(bars[i]!.t));
      if (before === null || after === null) return [];
      const x = (before + after) / 2;
      return x >= 0 && x <= width ? [x] : [];
    });
  }
}

class PaneSeparators implements IPanePrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(xs: () => readonly number[], color: () => string) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => drawSeparators(target, xs(), color()) };
    this.views = [{ zOrder: () => "bottom", renderer: () => renderer }];
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

function drawSeparators(target: Target, xs: readonly number[], color: string): void {
  if (xs.length === 0) return;
  target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
    const width = Math.max(1, Math.floor(horizontalPixelRatio));
    context.save();
    context.strokeStyle = color;
    context.lineWidth = width;
    context.setLineDash(DASH_PX.map((px) => px * verticalPixelRatio));
    context.beginPath();
    for (const x of xs) {
      const at = Math.round(x * horizontalPixelRatio) + (width % 2) / 2;
      context.moveTo(at, 0);
      context.lineTo(at, bitmapSize.height);
    }
    context.stroke();
    context.restore();
  });
}
