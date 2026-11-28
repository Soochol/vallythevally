import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  MouseEventParams,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { ChartExtension, ChartHost } from "../../chart/extensions";
import { fromChartTime, toChartTime } from "../../chart/time";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { CanvasPalette } from "./canvasTheme";
import type { ReplayChartTimeframe } from "./replayChartModel";
import type { ReplayWindow } from "./replayModel";
import type { PaperFill } from "./replayPaperEngine";

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export interface ReplayOverlayState {
  readonly dayStartUnix: UnixSeconds;
  readonly timeframe: ReplayChartTimeframe;
  readonly cursorSec: number;
  readonly blindMode: boolean;
  readonly bookmarks: readonly number[];
  readonly singlePriceWindows: readonly ReplayWindow[];
  readonly gapWindows: readonly ReplayWindow[];
  readonly avgPrice: number | null;
  readonly fills: readonly PaperFill[];
  readonly palette: CanvasPalette;
  readonly baseMinute: number;
}

function barUnixForSec(
  dayStartUnix: UnixSeconds,
  baseMinute: number,
  timeframe: ReplayChartTimeframe,
  sec: number,
): UnixSeconds {
  const minute = Math.floor(sec / 60);
  const bucket = baseMinute + Math.floor((minute - baseMinute) / timeframe) * timeframe;
  return dayStartUnix + bucket * 60;
}

class ReplayOverlayRenderer implements IPrimitivePaneRenderer {
  private readonly getState: () => ReplayOverlayState | null;
  private readonly getChart: () => IChartApi | null;
  private readonly getSeries: () => ISeriesApi<SeriesType, Time> | null;

  constructor(
    getState: () => ReplayOverlayState | null,
    getChart: () => IChartApi | null,
    getSeries: () => ISeriesApi<SeriesType, Time> | null,
  ) {
    this.getState = getState;
    this.getChart = getChart;
    this.getSeries = getSeries;
  }

  draw(target: DrawTarget): void {
    const state = this.getState();
    const chart = this.getChart();
    const series = this.getSeries();
    if (!state || !chart || !series) return;

    const timeScale = chart.timeScale();
    const xOfSec = (sec: number): number | null => {
      const unix = barUnixForSec(state.dayStartUnix, state.baseMinute, state.timeframe, sec);
      const coord = timeScale.timeToCoordinate(toChartTime(unix));
      return coord === null || !Number.isFinite(coord) ? null : coord;
    };

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: rx, verticalPixelRatio: ry, bitmapSize }) => {
      const W = bitmapSize.width;
      const H = bitmapSize.height;
      const { palette } = state;
      const barWidth = Math.max(4, timeScale.options().barSpacing) * rx;

      ctx.save();

      const drawBand = (windows: readonly ReplayWindow[], fillStyle: string) => {
        ctx.fillStyle = fillStyle;
        for (const win of windows) {
          const x0 = xOfSec(win.startSec);
          const x1 = xOfSec(win.endSec);
          if (x0 === null && x1 === null) continue;
          const left = x0 !== null ? x0 * rx - barWidth / 2 : 0;
          const right = x1 !== null ? x1 * rx + barWidth / 2 : left + barWidth;
          if (right < 0 || left > W) continue;
          const clampedLeft = Math.max(0, left);
          const clampedWidth = Math.max(barWidth * 0.5, Math.min(W, right) - clampedLeft);
          ctx.fillRect(clampedLeft, 0, clampedWidth, H);
        }
      };

      drawBand(state.singlePriceWindows, palette.warningSoft);
      drawBand(state.gapWindows, palette.dangerSoft);

      if (state.bookmarks.length > 0) {
        ctx.save();
        ctx.strokeStyle = palette.accent;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = Math.max(1, rx);
        ctx.setLineDash([3 * rx, 3 * rx]);
        for (const bm of state.bookmarks) {
          const x = xOfSec(bm);
          if (x === null) continue;
          const bx = Math.round(x * rx) + 0.5;
          if (bx < 0 || bx > W) continue;
          ctx.beginPath();
          ctx.moveTo(bx, 0);
          ctx.lineTo(bx, H);
          ctx.stroke();
        }
        ctx.restore();
      }

      if (state.avgPrice !== null && state.avgPrice > 0) {
        const rawY = series.priceToCoordinate(state.avgPrice);
        if (rawY !== null && Number.isFinite(rawY)) {
          const y = Math.round(rawY * ry) + 0.5;
          if (y >= 0 && y <= H) {
            ctx.save();
            ctx.strokeStyle = palette.up;
            ctx.lineWidth = Math.max(1.2, ry);
            ctx.setLineDash([4 * rx, 4 * rx]);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.stroke();
            ctx.setLineDash([]);

            const padX = 5 * rx;
            const boxH = 16 * ry;
            ctx.font = `700 ${Math.round(10 * ry)}px ${palette.fontSans}`;
            const label = "평단";
            const boxW = ctx.measureText(label).width + padX * 2;
            const bx = Math.max(4 * rx, W - boxW - 6 * rx);
            const by = Math.max(2 * ry, Math.min(H - boxH - 2 * ry, y - boxH / 2));
            ctx.fillStyle = palette.up;
            ctx.fillRect(bx, by, boxW, boxH);
            ctx.fillStyle = palette.accentInk;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(label, bx + padX, by + boxH / 2);
            ctx.restore();
          }
        }
      }

      for (const fill of state.fills) {
        const x = xOfSec(fill.ms / 1000);
        const rawY = series.priceToCoordinate(fill.price);
        if (x === null || rawY === null || !Number.isFinite(rawY)) continue;
        const fx = x * rx;
        const fy = Math.max(10 * ry, Math.min(H - 10 * ry, rawY * ry));
        if (fx < -barWidth || fx > W + barWidth) continue;
        const size = 5 * rx;
        ctx.fillStyle = fill.side === "buy" ? palette.up : palette.down;
        ctx.beginPath();
        if (fill.side === "buy") {
          ctx.moveTo(fx, fy + 4 * ry);
          ctx.lineTo(fx - size, fy + 12 * ry);
          ctx.lineTo(fx + size, fy + 12 * ry);
        } else {
          ctx.moveTo(fx, fy - 4 * ry);
          ctx.lineTo(fx - size, fy - 12 * ry);
          ctx.lineTo(fx + size, fy - 12 * ry);
        }
        ctx.closePath();
        ctx.fill();
      }

      const playX = xOfSec(state.cursorSec);
      if (playX !== null) {
        const px = Math.round(playX * rx) + 0.5;
        if (px >= 0 && px <= W) {
          ctx.strokeStyle = palette.accent;
          ctx.lineWidth = Math.max(1.4, 1.4 * rx);
          ctx.beginPath();
          ctx.moveTo(px, 0);
          ctx.lineTo(px, H);
          ctx.stroke();

          ctx.fillStyle = palette.accent;
          ctx.beginPath();
          ctx.arc(px, 5 * ry, 3.5 * rx, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
    });
  }
}

class ReplayOverlayPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private state: ReplayOverlayState | null = null;
  private readonly view: IPrimitivePaneView;

  constructor() {
    const renderer = new ReplayOverlayRenderer(
      () => this.state,
      () => this.chart,
      () => this.series,
    );
    this.view = {
      zOrder: () => "top",
      renderer: () => renderer,
    };
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  setState(next: ReplayOverlayState | null): void {
    this.state = next;
    this.requestUpdate?.();
  }
}

export class ReplayChartExtension implements ChartExtension {
  private readonly host: ChartHost;
  private readonly primitive = new ReplayOverlayPrimitive();
  private attachedSeries: ISeriesApi<SeriesType, Time> | null = null;
  private readonly onScrub: (sec: number) => void;
  private dayStartUnix: UnixSeconds = 0;

  constructor(host: ChartHost, onScrub: (sec: number) => void) {
    this.host = host;
    this.onScrub = onScrub;
    this.attachToMain();
    this.host.chart.subscribeClick(this.handleClick);
  }

  private attachToMain(): void {
    const next = this.host.series();
    if (this.attachedSeries === next) return;
    if (this.attachedSeries) {
      this.attachedSeries.detachPrimitive(this.primitive);
    }
    this.attachedSeries = next;
    next.attachPrimitive(this.primitive);
  }

  private readonly handleClick = (param: MouseEventParams<Time>): void => {
    if (param.time === undefined || typeof param.time !== "number") return;
    if (this.dayStartUnix <= 0) return;
    const unixT = fromChartTime(param.time as UTCTimestamp);
    const sec = unixT - this.dayStartUnix;
    if (sec >= 0 && sec <= 86_400) {
      this.onScrub(sec);
    }
  };

  setOverlay(state: ReplayOverlayState | null): void {
    if (state) this.dayStartUnix = state.dayStartUnix;
    this.primitive.setState(state);
  }

  reattach(): void {
    this.attachToMain();
  }

  dispose(): void {
    this.host.chart.unsubscribeClick(this.handleClick);
    if (this.attachedSeries) {
      this.attachedSeries.detachPrimitive(this.primitive);
      this.attachedSeries = null;
    }
  }
}
