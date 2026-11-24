import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { QuoteDepthPoint } from "../../api/generated/QuoteDepthPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { normalizeHex } from "../../lib/colors";
import type { QuoteDepthSpec } from "../indicators/kinds";
import type { ThemeTokens } from "../theme";
import { toChartTime } from "../time";
import { drawDepth } from "./cells";
import type { QuoteView } from "./feed";

export interface QuoteDepthLayer {
  readonly spec: QuoteDepthSpec;
  readonly view: QuoteView<QuoteDepthPoint>;
}

export interface QuoteDepthHost {
  bars(): readonly { t: UnixSeconds }[];
  tokens(): ThemeTokens;
  layers(): readonly QuoteDepthLayer[];
}

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export class QuoteDepthHeatmap implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private views: IPrimitivePaneView[] = [];

  constructor(private readonly host: QuoteDepthHost) {}

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
    this.syncViews();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.views = [];
  }

  updateAllViews(): void {
    this.syncViews();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  redraw(): void {
    this.syncViews();
    this.requestUpdate?.();
  }

  private syncViews(): void {
    const layers = this.host.layers();
    if (layers.length === 0) {
      if (this.views.length > 0) this.views = [];
      return;
    }
    this.views = layers.map((layer) => {
      const renderer: IPrimitivePaneRenderer = { draw: (target: DrawTarget) => this.drawLayer(target, layer) };
      return {
        zOrder: () => (layer.spec.aboveBars ? "normal" : "bottom"),
        renderer: () => renderer,
      };
    });
  }

  private drawLayer(target: DrawTarget, layer: QuoteDepthLayer): void {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return;
    const bars = this.host.bars();
    if (bars.length === 0) return;
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return;
    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(bars.length - 1, Math.ceil(range.to));
    if (from > to) return;
    const tokens = this.host.tokens();
    const ask = layer.spec.askColor ?? normalizeHex(tokens.down);
    const bid = layer.spec.bidColor ?? normalizeHex(tokens.up);
    if (!ask || !bid) return;
    const barSpacing = timeScale.options().barSpacing;
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => {
      const width = Math.max(1, barSpacing * 0.9 * horizontalPixelRatio);
      drawDepth(
        context,
        {
          from,
          to,
          width,
          point: (index) => {
            const bar = bars[index];
            return bar ? layer.view.at(bar.t) : undefined;
          },
          x: (index) => {
            const bar = bars[index];
            if (!bar) return null;
            const coord = timeScale.timeToCoordinate(toChartTime(bar.t));
            return coord === null ? null : coord * horizontalPixelRatio;
          },
          y: (price) => {
            const coord = series.priceToCoordinate(price);
            return coord === null ? null : coord * verticalPixelRatio;
          },
        },
        {
          ask,
          bid,
          maxOpacity: layer.spec.maxOpacity,
          topLevels: layer.spec.topLevels,
        },
      );
    });
  }
}
