import { PriceScaleMode, type IChartApi } from "lightweight-charts";

export type AxisSide = "right" | "left";

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
  private readonly axes = new WeakMap<HTMLElement, Record<AxisSide, CachedAxis>>();

  constructor(private readonly chart: IChartApi, private readonly requestFrame: () => void, private readonly labelled: (series: object) => boolean = () => false) {}

  record(pane: Pane, side: AxisSide = "right"): void {
    const key = pane.getHTMLElement();
    if (!key) return;
    const axis = this.axis(key, side);
    const time = document.timeline.currentTime;
    axis.formattedAt = typeof time === "number" ? time : null;
    this.requestFrame();
  }

  lastCoordinates(pane: Pane, side: AxisSide = "right"): number[] {
    const key = pane.getHTMLElement();
    const last = key ? this.axes.get(key)?.[side]?.input?.last : undefined;
    if (!last) return [];
    const coordinates: number[] = [];
    for (const entry of last) {
      const y = entry.series.priceToCoordinate(entry.price);
      if (y !== null) coordinates.push(y);
    }
    return coordinates;
  }

  failed(pane: Pane, error: unknown, side: AxisSide = "right"): void {
    const key = pane.getHTMLElement();
    if (!key) return;
    this.fail(this.axis(key, side), error);
    this.requestFrame();
  }

  refresh(frame: number): boolean {
    let deferred = false;
    for (const pane of this.chart.panes()) {
      const key = pane.getHTMLElement();
      if (!key) continue;
      if (this.refreshSide(pane, key, "right", frame)) deferred = true;
      if (this.leftVisible(pane) && this.refreshSide(pane, key, "left", frame)) deferred = true;
    }
    return deferred;
  }

  private leftVisible(pane: Pane): boolean {
    try {
      return pane.priceScale("left").options().visible;
    } catch {
      return false;
    }
  }

  private refreshSide(pane: Pane, key: HTMLElement, side: AxisSide, frame: number): boolean {
    let deferred = false;
    const axis = this.axis(key, side);
    if (axis.collectedAt !== frame) {
      axis.collectedAt = frame;
      try {
        const input = this.input(pane, side);
        const alreadyFormatted = axis.input !== null && axis.formattedAt === frame && sameScaleConfig(axis.input, input);
        if (!alreadyFormatted) axis.pending ||= !axis.input || !sameInput(axis.input, input);
        axis.input = input;
      } catch (error) {
        this.fail(axis, error);
      }
    }
    if (!axis.input) deferred = true;
    if (!axis.pending) return deferred;
    if (axis.formattedAt === frame || axis.invalidatedAt === frame) return true;
    axis.pending = false;
    axis.invalidatedAt = frame;
    try {
      pane.priceScale(side).applyOptions({});
      if (axis.input) axis.failed = false;
    } catch (error) {
      this.fail(axis, error);
      deferred = true;
    }
    return deferred;
  }

  private axis(key: HTMLElement, side: AxisSide): CachedAxis {
    let pair = this.axes.get(key);
    if (!pair) {
      const empty = (): CachedAxis => ({ input: null, collectedAt: null, formattedAt: null, invalidatedAt: null, pending: false, failed: false });
      pair = { right: empty(), left: empty() };
      this.axes.set(key, pair);
    }
    return pair[side];
  }

  private fail(axis: CachedAxis, error: unknown): void {
    axis.input = null;
    axis.pending = true;
    if (!axis.failed) console.error("Axis label input unavailable; retrying next frame", error);
    axis.failed = true;
  }

  private input(pane: Pane, side: AxisSide): AxisInput {
    const scale = pane.priceScale(side);
    const range = scale.getVisibleRange();
    const options = scale.options();
    const layout = this.chart.options().layout;
    const usesPercentBase = options.mode === PriceScaleMode.Percentage || options.mode === PriceScaleMode.IndexedTo100;
    const visible = usesPercentBase ? this.chart.timeScale().getVisibleLogicalRange() : null;
    return {
      percentBaseIndex: visible ? Math.floor(visible.from) : null, min: range?.from ?? null, max: range?.to ?? null,
      height: pane.getHeight(), mode: options.mode, inverted: options.invertScale, font: layout.fontFamily, fontSize: layout.fontSize, minimumWidth: options.minimumWidth,
      last: pane.getSeries().flatMap((series) => {
        const seriesOptions = series.options();
        const seriesScaleId = "priceScaleId" in seriesOptions && typeof seriesOptions.priceScaleId === "string" && seriesOptions.priceScaleId !== "" ? seriesOptions.priceScaleId : "right";
        if (seriesScaleId !== side) return [];
        if (!seriesOptions.visible || !(seriesOptions.lastValueVisible || this.labelled(series))) return [];
        const last = series.lastValueData(false);
        return last.noData ? [] : [{ series, price: last.price, y: series.priceToCoordinate(last.price) }];
      }),
    };
  }
}
