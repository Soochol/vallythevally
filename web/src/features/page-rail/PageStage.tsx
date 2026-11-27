import { EtfPage } from "../etf-page/EtfPage";
import { HeatmapPage } from "../heatmap-page/HeatmapPage";
import { JournalPage } from "../journal-page/JournalPage";
import { MarketPage } from "../market-page/MarketPage";
import { ReplayPage } from "../replay-page/ReplayPage";
import { ALL_PAGES, type ContentPageId } from "./pages";
import "./pageRail.css";

const BODIES = { market: MarketPage, heatmap: HeatmapPage, etf: EtfPage, replay: ReplayPage, journal: JournalPage } as const;

export function PageStage({ page }: { page: ContentPageId }) {
  const Body = BODIES[page];
  return (
    <main aria-label={ALL_PAGES.find((entry) => entry.id === page)!.label} className="page-stage">
      <Body />
    </main>
  );
}
