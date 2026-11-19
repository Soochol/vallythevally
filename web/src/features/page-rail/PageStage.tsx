import { EtfPage } from "../etf-page/EtfPage";
import { HeatmapPage } from "../heatmap-page/HeatmapPage";
import { MarketPage } from "../market-page/MarketPage";
import { ALL_PAGES, type ContentPageId } from "./pages";
import "./pageRail.css";

const BODIES = { market: MarketPage, heatmap: HeatmapPage, etf: EtfPage } as const;

export function PageStage({ page }: { page: ContentPageId }) {
  const Body = BODIES[page];
  return (
    <main aria-label={ALL_PAGES.find((entry) => entry.id === page)!.label} className="page-stage">
      <Body />
    </main>
  );
}
