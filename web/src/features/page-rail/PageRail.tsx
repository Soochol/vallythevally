import { Link } from "react-router";
import { ClockIcon, EtfIcon, HeatmapIcon, KeyboardIcon, MarketIcon, WorkspaceIcon } from "../icons";
import { useSelectionStore } from "../../stores/selection";
import { RAIL_PAGES, type PageId } from "./pages";
import "./pageRail.css";

const ICONS = { workspace: WorkspaceIcon, market: MarketIcon, heatmap: HeatmapIcon, etf: EtfIcon, replay: ClockIcon } as const;

export function PageRail({ page }: { page: PageId }) {
  return (
    <nav aria-label="페이지 메뉴" className="page-rail ui-island max-md:hidden">
      {RAIL_PAGES.map(({ id, path, label }) => {
        const Glyph = ICONS[id];
        return (
          <Link key={id} to={path} className="page-rail-item" aria-current={page === id ? "page" : undefined}>
            <Glyph size={19} />
            <span>{label}</span>
          </Link>
        );
      })}
      <span className="page-rail-spacer" />
      <button type="button" className="page-rail-item" title="단축키 (?)" aria-haspopup="dialog" onClick={() => useSelectionStore.getState().openHotkeySheet()}>
        <KeyboardIcon size={19} />
        <span>단축키</span>
      </button>
    </nav>
  );
}
