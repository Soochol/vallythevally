import {
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesWhitespaceData,
  customSeriesDefaultOptions,
  type IChartApi,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type ISeriesApi,
  type PaneRendererCustomData,
  type SeriesPartialOptions,
  type Time,
  type WhitespaceData,
} from "lightweight-charts";
import type { LineWidth } from "../settings";

export interface OverlayPoint extends CustomData<Time> {
  value?: number;
  base: number;
  connect?: boolean;
}

const HALO_WIDTH = 8;
const HALO_ALPHA = 0.18;

export interface OverlayOptions extends CustomSeriesOptions {
  lineWidth: LineWidth;
  halo: boolean;
}

export type OverlaySeries = ISeriesApi<"Custom", Time, OverlayPoint | WhitespaceData<Time>, OverlayOptions>;

export class OverlayLineView implements ICustomSeriesPaneView<Time, OverlayPoint, OverlayOptions> {
  constructor(private readonly priceOverlay = true) {}
  private data: PaneRendererCustomData<Time, OverlayPoint> | null = null;
  private options: OverlayOptions | null = null;

  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target, toY) =>
        target.useMediaCoordinateSpace(({ context: ctx }) => {
          const { data, options } = this;
          if (!data?.visibleRange || !options) return;
          ctx.beginPath();
          let started = false;
          for (let i = data.visibleRange.from; i < data.visibleRange.to; i++) {
            const bar = data.bars[i];
            const v = bar?.originalData.value;
            if (bar === undefined || v === undefined) continue;
            const y = toY(v);
            if (y === null) continue;
            if (bar.originalData.connect === false) started = false;
            if (started) ctx.lineTo(bar.x, y);
            else ctx.moveTo(bar.x, y);
            started = true;
            if (bar.originalData.connect !== undefined) {
              ctx.moveTo(bar.x + 2, y);
              ctx.arc(bar.x, y, 2, 0, 2 * Math.PI);
              ctx.moveTo(bar.x, y);
            }
          }
          ctx.strokeStyle = options.color;
          ctx.lineJoin = "round";
          ctx.lineCap = "butt";
          if (options.halo) {
            ctx.save();
            ctx.globalAlpha = HALO_ALPHA;
            ctx.lineWidth = HALO_WIDTH;
            ctx.stroke();
            ctx.restore();
          }
          ctx.lineWidth = options.lineWidth;
          ctx.stroke();
        }),
    };
  }

  update(data: PaneRendererCustomData<Time, OverlayPoint>, options: OverlayOptions): void {
    this.data = data;
    this.options = options;
  }

  /** Lightweight Charts는 마지막 값을 종가로 보고 % 기준으로 쓴다. */
  priceValueBuilder(p: OverlayPoint): number[] {
    if (!this.priceOverlay) return [p.value ?? p.base];
    return p.value === undefined ? [p.base] : [p.value, p.base];
  }

  isWhitespace(p: OverlayPoint | CustomSeriesWhitespaceData<Time>): p is CustomSeriesWhitespaceData<Time> {
    return !("base" in p);
  }

  defaultOptions(): OverlayOptions {
    return { ...customSeriesDefaultOptions, lineWidth: 1, halo: false };
  }
}

export function addOverlayLine(chart: IChartApi, options: SeriesPartialOptions<OverlayOptions>, pane: number, priceOverlay = true): OverlaySeries {
  return chart.addCustomSeries(new OverlayLineView(priceOverlay), options, pane);
}
