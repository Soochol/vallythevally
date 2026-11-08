import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  type PriceFormat,
} from "lightweight-charts";
import type { Bar } from "../api/generated/Bar";
import { formatPrice, formatVolume } from "../lib/format";
import type { ChartStyle } from "./settings";
import type { ThemeTokens } from "./theme";
import { toChartTime } from "./time";

/** 봉 모양마다 시리즈 종류가 다르다. 모양을 바꾸면 지우고 새로 만든다(frontend.md §5.7). */
export type MainSeries =
  | { style: "candle"; api: ISeriesApi<"Candlestick"> }
  | { style: "bar"; api: ISeriesApi<"Bar"> }
  | { style: "line"; api: ISeriesApi<"Line"> }
  | { style: "area"; api: ISeriesApi<"Area"> };

export const VOLUME_SCALE_ID = "volume";

export function priceFormat(isIndex: boolean): PriceFormat {
  return { type: "custom", minMove: isIndex ? 0.01 : 1, formatter: (p: number) => formatPrice(p, isIndex) };
}

function colors(style: ChartStyle, t: ThemeTokens) {
  switch (style) {
    case "candle":
      return { upColor: t.up, downColor: t.down, borderUpColor: t.up, borderDownColor: t.down, wickUpColor: t.up, wickDownColor: t.down };
    case "bar":
      return { upColor: t.up, downColor: t.down };
    case "line":
      return { color: t.seriesLine };
    case "area":
      return { lineColor: t.seriesLine, topColor: t.seriesFill, bottomColor: "transparent" };
  }
}

export function addMainSeries(chart: IChartApi, style: ChartStyle, t: ThemeTokens, isIndex: boolean): MainSeries {
  const common = { priceFormat: priceFormat(isIndex) };
  switch (style) {
    case "candle":
      return { style, api: chart.addSeries(CandlestickSeries, { ...common, ...colors(style, t) }) };
    case "bar":
      return { style, api: chart.addSeries(BarSeries, { ...common, ...colors(style, t), thinBars: false }) };
    case "line":
      return { style, api: chart.addSeries(LineSeries, { ...common, ...colors(style, t), lineWidth: 2 }) };
    case "area":
      return { style, api: chart.addSeries(AreaSeries, { ...common, ...colors(style, t), lineWidth: 2 }) };
  }
}

export function applyMainColors(main: MainSeries, t: ThemeTokens): void {
  main.api.applyOptions(colors(main.style, t));
}

export function setMainData(main: MainSeries, bars: Bar[]): void {
  switch (main.style) {
    case "candle":
    case "bar":
      main.api.setData(bars.map((b) => ({ time: toChartTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
      return;
    case "line":
    case "area":
      main.api.setData(bars.map((b) => ({ time: toChartTime(b.t), value: b.c })));
      return;
  }
}

/** 거래량은 지표가 아니라 봉의 v를 그대로 막대로 그린다(#2). 칸 아래쪽 20%에 자기 축으로 둔다. */
export function addVolumeSeries(chart: IChartApi): ISeriesApi<"Histogram"> {
  const s = chart.addSeries(HistogramSeries, {
    priceScaleId: VOLUME_SCALE_ID,
    priceFormat: { type: "custom", minMove: 1, formatter: formatVolume },
    priceLineVisible: false,
    lastValueVisible: false,
  });
  chart.priceScale(VOLUME_SCALE_ID).applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  return s;
}

/** 점마다 색이 들어가므로 테마를 바꾸면 다시 setData 해야 한다. */
export function setVolumeData(series: ISeriesApi<"Histogram">, bars: Bar[], t: ThemeTokens): void {
  series.setData(bars.map((b) => ({ time: toChartTime(b.t), value: b.v, color: b.c >= b.o ? t.upVol : t.downVol })));
}
