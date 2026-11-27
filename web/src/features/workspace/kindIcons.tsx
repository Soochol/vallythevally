import type { ReactNode } from "react";
import type { WindowKind } from "../../layout/kinds";
import { BookIcon, BrokersIcon, ChartIcon, FunnelIcon, IndicatorIcon, ListIcon, OrderIcon, PreMarketIcon, ProgramIcon, RankingIcon, TradesIcon } from "../icons";

export const KIND_ICONS: Record<WindowKind, ({ size }: { size?: number }) => ReactNode> = { chart: ChartIcon, watchlist: ListIcon, screener: FunnelIcon, indicators: IndicatorIcon, trades: TradesIcon, book: BookIcon, program: ProgramIcon, brokers: BrokersIcon, order: OrderIcon, ranking: RankingIcon, premarket: PreMarketIcon, scanner: RankingIcon, themes: ListIcon, tape_matrix: BookIcon };
