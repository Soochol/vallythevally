import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";

type Series = Pick<ISeriesApi<SeriesType, Time>, "seriesType" | "attachPrimitive" | "dataByIndex" | "priceToCoordinate" | "coordinateToPrice">;
declare global {
  interface Window { chartProbe: { chart: IChartApi; main: Series } }
}

export function installChartProbe() {
  const set = Map.prototype.set;
  const seen = new WeakSet<object>();
  const isSeries = (key: unknown): key is Series => typeof key === "object" && key !== null
    && "seriesType" in key && typeof key.seriesType === "function"
    && "attachPrimitive" in key && typeof key.attachPrimitive === "function"
    && "dataByIndex" in key && typeof key.dataByIndex === "function"
    && "priceToCoordinate" in key && typeof key.priceToCoordinate === "function"
    && "coordinateToPrice" in key && typeof key.coordinateToPrice === "function";
  Map.prototype.set = function (key: unknown, value: unknown) {
    if (isSeries(key) && key.seriesType() === "Candlestick" && !seen.has(key)) {
      seen.add(key);
      setTimeout(() => key.attachPrimitive({ attached: ({ chart }) => { window.chartProbe = { chart, main: key }; } }), 0);
    }
    return set.call(this, key, value);
  };
}
