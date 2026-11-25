import { PriceScaleMode, type IChartApi } from "lightweight-charts";

type Pane = ReturnType<IChartApi["panes"]>[number];
interface LabelledSeries {
  priceToCoordinate(price: number): number | null;
}

interface AxisInput {
  percentBaseIndex: number | null;
  min: number | null;
  max: number | null;
  height: number;
  mode: number;
  inverted: boolean;
  font: string;
  fontSize: number;
  minimumWidth: number;
  last: { series: LabelledSeries; price: number; y: number | null }[];
}
interface CachedAxis {
  input: AxisInput | null;
  collectedAt: number | null;
  formattedAt: number | null;
  invalidatedAt: number | null;
  pending: boolean;
  failed: boolean;
}

function sameScaleConfig(a: AxisInput, b: AxisInput): boolean {
  return a.percentBaseIndex === b.percentBaseIndex
    && a.height === b.height && a.mode === b.mode && a.inverted === b.inverted && a.font === b.font && a.fontSize === b.fontSize && a.minimumWidth === b.minimumWidth
    && a.last.length === b.last.length && a.last.every((last, i) => {
      const next = b.last[i]!;
      return last.series === next.series && last.price === next.price;
    });
}

function sameInput(a: AxisInput, b: AxisInput): boolean {
  return sameScaleConfig(a, b) && a.min === b.min && a.max === b.max
    && a.last.every((last, i) => last.y === b.last[i]!.y);
}

export class AxisLabelCache {
  private readonly axes = new WeakMap<HTMLElement, CachedAxis>();

  constructor(private readonly chart: IChartApi, private readonly requestFrame: () => void, private readonly labelled: (series: object) => boolean = () => false) {}

  record(pane: Pane): void {
    const key = pane.getHTMLElement();
    if (!key) return;
    const axis = this.axis(key);
    const time = document.timeline.currentTime;
    axis.formattedAt = typeof time === "number" ? time : null;
    this.requestFrame();
  }

  lastCoordinates(pane: Pane): number[] {
    const key = pane.getHTMLElement();
    const last = key ? this.axes.get(key)?.input?.last : undefined;
    if (!last) return [];
    const coordinates: number[] = [];
    for (const entry of last) {
      const y = entry.series.priceToCoordinate(entry.price);
      if (y !== null) coordinates.push(y);
    }
    return coordinates;
  }

  failed(pane: Pane, error: unknown): void {
    const key = pane.getHTMLElement();
    if (!key) return;
    this.fail(this.axis(key), error);
    this.requestFrame();
  }

  refresh(frame: number): boolean {
    let deferred = false;
    for (const pane of this.chart.panes()) {
      const key = pane.getHTMLElement();
      if (!key) continue;
      const axis = this.axis(key);
      if (axis.collectedAt !== frame) {
        axis.collectedAt = frame;
        try {
          const input = this.input(pane);
          const alreadyFormatted = axis.input !== null && axis.formattedAt === frame && sameScaleConfig(axis.input, input);
          if (!alreadyFormatted) axis.pending ||= !axis.input || !sameInput(axis.input, input);
          axis.input = input;
        } catch (error) {
          this.fail(axis, error);
        }
      }
      if (!axis.input) deferred = true;
      if (!axis.pending) continue;
      if (axis.formattedAt === frame || axis.invalidatedAt === frame) { deferred = true; continue; }
      axis.pending = false;
      axis.invalidatedAt = frame;
      try {
        pane.priceScale("right").applyOptions({});
        if (axis.input) axis.failed = false;
      } catch (error) {
        this.fail(axis, error);
        deferred = true;
      }
    }
    return deferred;
  }

  private axis(key: HTMLElement): CachedAxis {
    let axis = this.axes.get(key);
    if (!axis) {
      axis = { input: null, collectedAt: null, formattedAt: null, invalidatedAt: null, pending: false, failed: false };
      this.axes.set(key, axis);
    }
    return axis;
  }

  private fail(axis: CachedAxis, error: unknown): void {
    axis.input = null;
    axis.pending = true;
    if (!axis.failed) console.error("Axis label input unavailable; retrying next frame", error);
    axis.failed = true;
  }

  private input(pane: Pane): AxisInput {
    const scale = pane.priceScale("right");
    const range = scale.getVisibleRange();
    const options = scale.options();
    const layout = this.chart.options().layout;
    const usesPercentBase = options.mode === PriceScaleMode.Percentage || options.mode === PriceScaleMode.IndexedTo100;
    const visible = usesPercentBase ? this.chart.timeScale().getVisibleLogicalRange() : null;
    return {
      percentBaseIndex: visible ? Math.floor(visible.from) : null, min: range?.from ?? null, max: range?.to ?? null,
      height: pane.getHeight(), mode: options.mode, inverted: options.invertScale, font: layout.fontFamily, fontSize: layout.fontSize, minimumWidth: options.minimumWidth,
      last: pane.getSeries().flatMap((series) => {
        const options = series.options();
        if (!options.visible || !(options.lastValueVisible || this.labelled(series))) return [];
        const last = series.lastValueData(false);
        return last.noData ? [] : [{ series, price: last.price, y: series.priceToCoordinate(last.price) }];
      }),
    };
  }
}
