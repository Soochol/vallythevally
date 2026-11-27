import { useSyncExternalStore } from "react";
import { Link } from "react-router";
import { appliedThemeMode, chooseThemeMode, DEFAULT_THEME_MODE, subscribeTheme } from "../../persist/theme";
import { ClockIcon, EtfIcon, HeatmapIcon, JournalIcon, KeyboardIcon, MarketIcon, MoonIcon, SunIcon, WorkspaceIcon } from "../icons";
import { SystemButton } from "../system-settings/SystemButton";
import { useSelectionStore } from "../../stores/selection";
import { RAIL_PAGES, type PageId } from "./pages";
import "./pageRail.css";

const ICONS = { workspace: WorkspaceIcon, market: MarketIcon, heatmap: HeatmapIcon, etf: EtfIcon, replay: ClockIcon, journal: JournalIcon } as const;

export function PageRail({ page }: { page: PageId }) {
  const mode = useSyncExternalStore(subscribeTheme, () => appliedThemeMode(), () => DEFAULT_THEME_MODE);
  const nextMode = mode === "dark" ? "light" : "dark";
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
      <button
        type="button"
        className="page-rail-item"
        aria-label={mode === "dark" ? "화이트 모드로 전환" : "다크 모드로 전환"}
        title={mode === "dark" ? "화이트 모드로 전환" : "다크 모드로 전환"}
        onClick={() => chooseThemeMode(nextMode)}
      >
        {mode === "dark" ? <SunIcon size={19} /> : <MoonIcon size={19} />}
        <span>{mode === "dark" ? "화이트" : "다크"}</span>
      </button>
      <button type="button" className="page-rail-item" title="단축키 (?)" aria-haspopup="dialog" onClick={() => useSelectionStore.getState().openHotkeySheet()}>
        <KeyboardIcon size={19} />
        <span>단축키</span>
      </button>
      <SystemButton />
    </nav>
  );
}
