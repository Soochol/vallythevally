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
import type { MicroEvent } from "../../api/generated/MicroEvent";
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
  readonly microEvents?: readonly MicroEvent[];
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
      if ((layer.spec.showSpoof === true || layer.spec.showIceberg === true) && layer.microEvents && layer.microEvents.length > 0) {
        drawMicroMarkers(context, {
          bars,
          from,
          to,
          events: layer.microEvents,
          showSpoof: layer.spec.showSpoof === true,
          showIceberg: layer.spec.showIceberg === true,
          verbose: layer.spec.microLabelMode === "verbose",
          spoofColor: tokens.ind?.["ind-1"] || tokens.down,
          icebergColor: tokens.accent || tokens.up,
          bgColor: tokens.chartBg || "#080B09",
          textColor: tokens.onData || "#0B0E0C",
          fontFamily: tokens.fontFamily || "sans-serif",
          horizontalPixelRatio,
          verticalPixelRatio,
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
        });
      }
    });
  }
}

interface MicroMarkerArgs {
  readonly bars: readonly { t: UnixSeconds }[];
  readonly from: number;
  readonly to: number;
  readonly events: readonly MicroEvent[];
  readonly showSpoof: boolean;
  readonly showIceberg: boolean;
  readonly verbose: boolean;
  readonly spoofColor: string;
  readonly icebergColor: string;
  readonly bgColor: string;
  readonly textColor: string;
  readonly fontFamily: string;
  readonly horizontalPixelRatio: number;
  readonly verticalPixelRatio: number;
  x(index: number): number | null;
  y(price: number): number | null;
}

function barIndexForSec(bars: readonly { t: UnixSeconds }[], from: number, to: number, sec: number): number {
  let lo = from;
  let hi = to;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t <= sec) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function shortMicroBadge(event: MicroEvent): string {
  if (event.kind === "spoof_cancel") {
    return `허수 ${Math.round(event.ratioBps / 100)}%`;
  }
  return `흡수 ${(event.ratioBps / 10_000).toFixed(1)}x`;
}

function drawMicroMarkers(ctx: CanvasRenderingContext2D, args: MicroMarkerArgs): void {
  const { bars, from, to, events, showSpoof, showIceberg, verbose, spoofColor, icebergColor, bgColor, textColor, fontFamily, horizontalPixelRatio, verticalPixelRatio } = args;
  const startSec = bars[from]!.t;
  const stepSec = to > from ? Math.max(60, bars[to]!.t - bars[to - 1]!.t) : 60;
  const endSec = bars[to]!.t + stepSec;
  const radius = Math.max(2.5, 3.5 * horizontalPixelRatio);
  const strokeWidth = Math.max(1, 1.25 * horizontalPixelRatio);
  const fontSize = Math.max(9, Math.round(10 * verticalPixelRatio));

  ctx.save();
  if (verbose) {
    ctx.font = `600 ${fontSize}px ${fontFamily}`;
    ctx.textBaseline = "middle";
  }
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind === "spoof_cancel" && !showSpoof) continue;
    if (event.kind === "iceberg_absorb" && !showIceberg) continue;
    const sec = Math.floor(event.recvMs / 1000);
    if (sec < startSec || sec >= endSec) continue;
    const barIdx = barIndexForSec(bars, from, to, sec);
    if (barIdx < from || barIdx > to) continue;
    const px = args.x(barIdx);
    const py = args.y(event.priceWon);
    if (px === null || py === null) continue;
    const color = event.kind === "spoof_cancel" ? spoofColor : icebergColor;

    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = bgColor;
    ctx.stroke();

    if (verbose) {
      const text = shortMicroBadge(event);
      const padX = Math.max(3, 4 * horizontalPixelRatio);
      const boxW = ctx.measureText(text).width + padX * 2;
      const boxH = fontSize + Math.max(3, 4 * verticalPixelRatio);
      const boxX = px + radius + Math.max(3, 4 * horizontalPixelRatio);
      const boxY = py - boxH / 2;
      ctx.fillStyle = color;
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = textColor;
      ctx.fillText(text, boxX + padX, py);
    }
  }
  ctx.restore();
}
