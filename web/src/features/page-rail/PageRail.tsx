import { Link } from "react-router";
import { EtfIcon, GearIcon, HeatmapIcon, MarketIcon, WorkspaceIcon } from "../icons";
import { openSystemSettings } from "../system-settings/open";
import { RAIL_PAGES, type PageId } from "./pages";
import "./pageRail.css";

const ICONS = { workspace: WorkspaceIcon, market: MarketIcon, heatmap: HeatmapIcon, etf: EtfIcon } as const;

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
      <button type="button" className="page-rail-item" title="시스템 설정" aria-haspopup="dialog" onClick={() => openSystemSettings()}>
        <GearIcon size={19} />
        <span>설정</span>
      </button>
    </nav>
  );
}
