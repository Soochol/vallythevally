import type { IChartApi } from "lightweight-charts";
import type { Bar } from "../api/generated/Bar";
import type { CellView } from "./ChartController";
import type { MainSeries } from "./series";

export interface ChartHost {
  el: HTMLElement;
  chart: IChartApi;
  series(): MainSeries["api"];
  bars(): readonly Bar[];
  view(): CellView | null;
}
export interface ChartExtension {
  reattach(): void;
  dispose(): void;
}
export type ExtensionFactory = (host: ChartHost) => ChartExtension;
