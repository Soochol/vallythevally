import type { IChartApi } from "lightweight-charts";

type Pane = ReturnType<IChartApi["panes"]>[number];
interface AxisInput {
  from: number | null;
  to: number | null;
  min: number | null;
  max: number | null;
  height: number;
  mode: number;
  inverted: boolean;
  font: string;
  fontSize: number;
  last: { series: object; price: number; y: number | null }[];
}
interface CachedAxis {
  input: AxisInput;
  formattedAt: number | null;
  invalidatedAt: number | null;
}

function sameInput(a: AxisInput, b: AxisInput): boolean {
  return a.from === b.from && a.to === b.to && a.min === b.min && a.max === b.max
    && a.height === b.height && a.mode === b.mode && a.inverted === b.inverted && a.font === b.font && a.fontSize === b.fontSize
    && a.last.length === b.last.length && a.last.every((last, i) => {
      const next = b.last[i]!;
      return last.series === next.series && last.price === next.price && last.y === next.y;
    });
}

export class AxisLabelCache {
  private readonly axes = new WeakMap<HTMLElement, CachedAxis>();

  constructor(private readonly chart: IChartApi) {}

  record(pane: Pane): void {
    const key = pane.getHTMLElement();
    if (!key) return;
    const previous = this.axes.get(key);
    const time = document.timeline.currentTime;
    this.axes.set(key, { input: this.input(pane), formattedAt: typeof time === "number" ? time : null, invalidatedAt: previous?.invalidatedAt ?? null });
  }

  refresh(frame: number): boolean {
    let deferred = false;
    for (const pane of this.chart.panes()) {
      const key = pane.getHTMLElement();
      if (!key) continue;
      const previous = this.axes.get(key);
      const input = this.input(pane);
      if (previous && sameInput(previous.input, input)) continue;
      if (previous?.formattedAt === frame || previous?.invalidatedAt === frame) { deferred = true; continue; }
      this.axes.set(key, { input, formattedAt: previous?.formattedAt ?? null, invalidatedAt: frame });
      pane.priceScale("right").applyOptions({});
    }
    return deferred;
  }

  private input(pane: Pane): AxisInput {
    const visible = this.chart.timeScale().getVisibleLogicalRange();
    const scale = pane.priceScale("right");
    const range = scale.getVisibleRange();
    const options = scale.options();
    const layout = this.chart.options().layout;
    return {
      from: visible?.from ?? null, to: visible?.to ?? null, min: range?.from ?? null, max: range?.to ?? null,
      height: pane.getHeight(), mode: options.mode, inverted: options.invertScale, font: layout.fontFamily, fontSize: layout.fontSize,
      last: pane.getSeries().flatMap((series) => {
        const options = series.options();
        if (!options.visible || !options.lastValueVisible) return [];
        const last = series.lastValueData(false);
        return last.noData ? [] : [{ series, price: last.price, y: series.priceToCoordinate(last.price) }];
      }),
    };
  }
}
