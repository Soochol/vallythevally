import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  type PriceFormat,
} from "lightweight-charts";
import type { Bar } from "../api/generated/Bar";
import { axisPriceFormat } from "./axisFormat";
import type { ChartStyle } from "./settings";
import type { ThemeTokens } from "./theme";
import { toChartTime } from "./time";

/** 봉 모양마다 시리즈 종류가 다르다. 모양을 바꾸면 지우고 새로 만든다(frontend.md §5.7). */
export type MainSeries =
  | { style: "candle"; api: ISeriesApi<"Candlestick"> }
  | { style: "bar"; api: ISeriesApi<"Bar"> }
  | { style: "line"; api: ISeriesApi<"Line"> }
  | { style: "area"; api: ISeriesApi<"Area"> };

export function priceFormat(isIndex: boolean, lastValues: () => number[] = () => []): PriceFormat {
  return axisPriceFormat(isIndex ? "index" : "price", isIndex ? 0.01 : 1, lastValues);
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

export function addMainSeries(chart: IChartApi, style: ChartStyle, t: ThemeTokens, isIndex: boolean, lastValues: () => number[] = () => []): MainSeries {
  const common = { priceFormat: priceFormat(isIndex, lastValues) };
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

/** 마지막 봉 하나를 바꾸거나 뒤에 붙인다. b.t는 시리즈의 마지막 시각보다 이르면 안 된다. */
export function updateMainBar(main: MainSeries, b: Bar): void {
  switch (main.style) {
    case "candle":
    case "bar":
      main.api.update({ time: toChartTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c });
      return;
    case "line":
    case "area":
      main.api.update({ time: toChartTime(b.t), value: b.c });
      return;
  }
}
