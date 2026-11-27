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
import type { Bar } from "../../api/generated/Bar";
import type { ThemeTokens } from "../theme";
import { toChartTime } from "../time";
import type { Point } from "./protocol";

export interface IchimokuCloudPoint extends CustomData<Time> {
  spanA?: number;
  spanB?: number;
  base: number;
}

export interface IchimokuCloudOptions extends CustomSeriesOptions {
  bullColor: string;
  bearColor: string;
  opacity: number;
}

export type IchimokuCloudSeries = ISeriesApi<"Custom", Time, IchimokuCloudPoint | WhitespaceData<Time>, IchimokuCloudOptions>;

export interface IchimokuPalette {
  conversion: string;
  base: string;
  spanA: string;
  spanB: string;
  lagging: string;
}

function isLightColor(hex: string | undefined): boolean {
  if (!hex) return false;
  const clean = hex.trim();
  if (!clean.startsWith("#") || (clean.length !== 7 && clean.length !== 4)) return false;
  const full = clean.length === 4
    ? `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`
    : clean;
  const r = Number.parseInt(full.slice(1, 3), 16);
  const g = Number.parseInt(full.slice(3, 5), 16);
  const b = Number.parseInt(full.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140;
}

export function ichimokuPalette(tokens: ThemeTokens): IchimokuPalette {
  if (isLightColor(tokens.chartBg)) {
    return {
      conversion: "#0284c7",
      base: "#d97706",
      spanA: "#059669",
      spanB: "#e11d48",
      lagging: "#7c3aed",
    };
  }
  return {
    conversion: "#38bdf8",
    base: "#f59e0b",
    spanA: "#10b981",
    spanB: "#f43f5e",
    lagging: "#a78bfa",
  };
}

export function buildIchimokuCloudPoints(
  spanA: readonly Point[],
  spanB: readonly Point[],
  display: readonly Bar[],
): IchimokuCloudPoint[] {
  const merged: IchimokuCloudPoint[] = [];
  let ia = 0;
  let ib = 0;
  let id = 0;
  while (ia < spanA.length && ib < spanB.length) {
    const a = spanA[ia]!;
    const b = spanB[ib]!;
    if (a.t < b.t) {
      ia++;
      continue;
    }
    if (b.t < a.t) {
      ib++;
      continue;
    }
    while (id < display.length && display[id]!.t < a.t) id++;
    const main = display[id];
    const base = main?.t === a.t ? main.c : (a.v + b.v) / 2;
    merged.push({ time: toChartTime(a.t), spanA: a.v, spanB: b.v, base });
    ia++;
    ib++;
  }
  const first = merged[0];
  if (!first) return [];
  const firstT = first.time as number;
  const warmup: IchimokuCloudPoint[] = [];
  for (const bar of display) {
    const t = toChartTime(bar.t) as number;
    if (t >= firstT) break;
    warmup.push({ time: toChartTime(bar.t), base: bar.c });
  }
  return warmup.length ? [...warmup, ...merged] : merged;
}

export class IchimokuCloudView implements ICustomSeriesPaneView<Time, IchimokuCloudPoint, IchimokuCloudOptions> {
  private data: PaneRendererCustomData<Time, IchimokuCloudPoint> | null = null;
  private options: IchimokuCloudOptions | null = null;

  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target, toY) =>
        target.useMediaCoordinateSpace(({ context: ctx }) => {
          const { data, options } = this;
          if (!data?.visibleRange || !options || options.opacity <= 0) return;
          const from = Math.max(0, data.visibleRange.from - 1);
          const to = Math.min(data.bars.length - 1, data.visibleRange.to);
          ctx.save();
          ctx.globalAlpha = options.opacity;
          for (let i = from; i < to; i++) {
            const p0 = data.bars[i];
            const p1 = data.bars[i + 1];
            const a0 = p0?.originalData.spanA;
            const b0 = p0?.originalData.spanB;
            const a1 = p1?.originalData.spanA;
            const b1 = p1?.originalData.spanB;
            if (p0 === undefined || p1 === undefined || a0 === undefined || b0 === undefined || a1 === undefined || b1 === undefined) continue;
            const ya0 = toY(a0);
            const yb0 = toY(b0);
            const ya1 = toY(a1);
            const yb1 = toY(b1);
            if (ya0 === null || yb0 === null || ya1 === null || yb1 === null) continue;
            const d0 = a0 - b0;
            const d1 = a1 - b1;
            if ((d0 >= 0 && d1 >= 0) || (d0 <= 0 && d1 <= 0)) {
              ctx.fillStyle = d0 + d1 >= 0 ? options.bullColor : options.bearColor;
              ctx.beginPath();
              ctx.moveTo(p0.x, ya0);
              ctx.lineTo(p1.x, ya1);
              ctx.lineTo(p1.x, yb1);
              ctx.lineTo(p0.x, yb0);
              ctx.closePath();
              ctx.fill();
            } else {
              const frac = d0 / (d0 - d1);
              const xc = p0.x + (p1.x - p0.x) * frac;
              const yc = ya0 + (ya1 - ya0) * frac;
              ctx.fillStyle = d0 >= 0 ? options.bullColor : options.bearColor;
              ctx.beginPath();
              ctx.moveTo(p0.x, ya0);
              ctx.lineTo(xc, yc);
              ctx.lineTo(p0.x, yb0);
              ctx.closePath();
              ctx.fill();
              ctx.fillStyle = d1 >= 0 ? options.bullColor : options.bearColor;
              ctx.beginPath();
              ctx.moveTo(xc, yc);
              ctx.lineTo(p1.x, ya1);
              ctx.lineTo(p1.x, yb1);
              ctx.closePath();
              ctx.fill();
            }
          }
          ctx.restore();
        }),
    };
  }

  update(data: PaneRendererCustomData<Time, IchimokuCloudPoint>, options: IchimokuCloudOptions): void {
    this.data = data;
    this.options = options;
  }

  priceValueBuilder(p: IchimokuCloudPoint): number[] {
    if (p.spanA === undefined || p.spanB === undefined) return [p.base];
    return [p.spanA, p.spanB, p.base];
  }

  isWhitespace(p: IchimokuCloudPoint | CustomSeriesWhitespaceData<Time>): p is CustomSeriesWhitespaceData<Time> {
    return !("base" in p);
  }

  defaultOptions(): IchimokuCloudOptions {
    return {
      ...customSeriesDefaultOptions,
      bullColor: "#10b981",
      bearColor: "#f43f5e",
      opacity: 0.18,
    };
  }
}

export function addIchimokuCloud(
  chart: IChartApi,
  options: SeriesPartialOptions<IchimokuCloudOptions>,
  pane: number,
): IchimokuCloudSeries {
  const series = chart.addCustomSeries(new IchimokuCloudView(), options, pane);
  series.setSeriesOrder(0);
  return series;
}
