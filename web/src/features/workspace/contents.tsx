import type { ComponentType } from "react";
import type { WindowId, WindowKind } from "../../layout/kinds";
import { BookWindow } from "../book/BookWindow";
import { BrokersWindow } from "../brokers/BrokersWindow";
import { OrderWindow } from "../order/OrderWindow";
import { IndicatorAddWindow } from "../indicator-command/IndicatorAddWindow";
import { PreMarketWindow } from "../premarket/PreMarketWindow";
import { ProgramWindow } from "../program/ProgramWindow";
import { RankingWindow } from "../ranking/RankingWindow";
import { ScannerWindow } from "../scanner/ScannerWindow";
import { ScreenerPanel } from "../screener/ScreenerPanel";
import { TapeMatrixWindow } from "../tape-matrix/TapeMatrixWindow";
import { ThemesWindow } from "../themes/ThemesWindow";
import { TradesWindow } from "../trades/TradesWindow";
import { WatchPanel } from "../watch/Watchlist";
import { WhaleWindow } from "../whale/WhaleWindow";
import { ChartWindow } from "./ChartWindow";

export type WindowContent = { readonly Content: ComponentType<{ id: WindowId }>; readonly overflow: "auto" | "hidden" };

export const WINDOW_CONTENT: { readonly [K in WindowKind]: WindowContent } = {
  chart: { Content: ChartWindow, overflow: "hidden" },
  watchlist: { Content: WatchPanel, overflow: "hidden" },
  screener: { Content: ScreenerPanel, overflow: "hidden" },
  indicators: { Content: IndicatorAddWindow, overflow: "hidden" },
  trades: { Content: TradesWindow, overflow: "hidden" },
  book: { Content: BookWindow, overflow: "hidden" },
  program: { Content: ProgramWindow, overflow: "hidden" },
  brokers: { Content: BrokersWindow, overflow: "hidden" },
  order: { Content: OrderWindow, overflow: "hidden" },
  ranking: { Content: RankingWindow, overflow: "hidden" },
  premarket: { Content: PreMarketWindow, overflow: "hidden" },
  scanner: { Content: ScannerWindow, overflow: "hidden" },
  themes: { Content: ThemesWindow, overflow: "hidden" },
  tape_matrix: { Content: TapeMatrixWindow, overflow: "hidden" },
  whale: { Content: WhaleWindow, overflow: "hidden" },
};
