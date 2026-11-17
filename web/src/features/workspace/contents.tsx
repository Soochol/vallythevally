import type { ComponentType } from "react";
import type { WindowId, WindowKind } from "../../layout/kinds";
import { ObjectList } from "../drawings/ObjectList";
import { IndicatorInspector } from "../indicator-inspector/IndicatorInspector";
import { ScreenerPanel } from "../screener/ScreenerPanel";
import { WatchPanel } from "../watch/Watchlist";
import { ChartWindow } from "./ChartWindow";

export type WindowContent = { readonly Content: ComponentType<{ id: WindowId }>; readonly overflow: "auto" | "hidden" };

export const WINDOW_CONTENT: { readonly [K in WindowKind]: WindowContent } = {
  chart: { Content: ChartWindow, overflow: "hidden" },
  watchlist: { Content: WatchPanel, overflow: "hidden" },
  screener: { Content: ScreenerPanel, overflow: "hidden" },
  objects: { Content: ObjectList, overflow: "auto" },
  indicators: { Content: IndicatorInspector, overflow: "hidden" },
};
