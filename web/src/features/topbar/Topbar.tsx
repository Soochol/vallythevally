import { BrandLink } from "../page-rail/BrandLink";
import { MinuteMenu } from "./MinuteMenu";
import { MockBadge } from "./MockBadge";
import { keyCapsLabel, keyTitle, periodActionId, searchTitle } from "../../lib/hotkeys";
import { useSymbolInfo } from "../../api/queries";
import { PERIOD_LABEL, PERIODS, symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { defaultIndicatorMode, useSelectionStore, type ChartPanelMode } from "../../stores/selection";
import { useActionKeys } from "../../stores/ui";
import { openIndicatorCommand, useShownIndicatorWindow } from "../indicator-command/open";
import { IndicatorIcon, SearchIcon, SlidersIcon, CompareIcon } from "../icons";
import { ArrangeMenu } from "../layouts/ArrangeMenu";
import { LayoutMenu } from "../layouts/LayoutMenu";
import { VenuePicker } from "../venue/VenuePicker";
import { AddWindowMenu } from "../workspace/AddWindowMenu";
import { BookReplayToggle } from "../book-replay/BookReplayToggle";
import { AutoGuardBadge } from "./AutoGuardBadge";
import { TopbarClock } from "./TopbarClock";

type PillSection = "indicators" | "compare" | "settings";

function sectionOf(mode: ChartPanelMode): PillSection {
  if (mode === "compare") return "compare";
  if (mode === "settings") return "settings";
  return "indicators";
}

export function Topbar() {
  const cellId = useSelectionStore((s) => s.activeCell);
  const openSearch = useSelectionStore((s) => s.openSearch);
  const dialog = useSelectionStore((s) => s.dialog);
  const chartDock = useSelectionStore((s) => s.chartDock);
  const cell = useCell(cellId);
  const opensDialog = useShownIndicatorWindow() === "dialog";
  const info = useSymbolInfo(cell.symbol).data;
  const name = info?.name ?? cell.symbol;
  const { setPeriod } = useLayoutStore.getState();
  const keys = useActionKeys();

  const activeMode: ChartPanelMode | null =
    dialog?.kind === "indicatorCommand" && dialog.cellId === cellId
      ? dialog.mode
      : chartDock?.cellId === cellId
        ? chartDock.mode
        : null;
  const activeSection = activeMode ? sectionOf(activeMode) : null;
  const indicatorCount = cell.chartSettings.indicators.length;
  const compareCount = cell.chartSettings.compare.length;

  const toggleSection = (section: PillSection) => {
    const selection = useSelectionStore.getState();
    if (activeSection === section) {
      if (dialog?.kind === "indicatorCommand") selection.closeDialog();
      if (chartDock?.cellId === cellId) selection.closeChartDock();
      return;
    }
    if (chartDock?.cellId === cellId) {
      const nextMode: ChartPanelMode = section === "indicators" ? defaultIndicatorMode(cellId) : section;
      selection.openChartDock(cellId, nextMode, null);
      return;
    }
    if (section === "settings") {
      selection.openIndicatorDialog(cellId, "settings", null);
      return;
    }
    openIndicatorCommand(cellId, section === "compare" ? "compare" : defaultIndicatorMode(cellId));
  };

  return (
    <header role="toolbar" aria-label="차트 도구 막대" className="desktop-topbar ui-island relative z-20 mx-[var(--island-gap)] mt-[var(--island-gap)] h-[var(--island-h)] flex-none rounded-l max-md:hidden">
      <div className="topbar-zone" data-zone="app">
        <BrandLink />
        <MockBadge />
        <VenuePicker variant="desktop" />
      </div>
      <span className="tb-sep" />
      <div className="topbar-zone" data-zone="cell">
        <div role="group" aria-label="봉 주기" className="ui-seg">
          <MinuteMenu value={cell.period} onChange={(period) => setPeriod(cellId, period)} />
          {PERIODS.filter((p) => !p.endsWith("m")).map((p) => (
            <button key={p} type="button" className="ui-seg-item" aria-pressed={cell.period === p}
              title={keyTitle(PERIOD_LABEL[p], keys, periodActionId(p))} onClick={() => setPeriod(cellId, p)}>{PERIOD_LABEL[p]}</button>
          ))}
        </div>
        <div role="group" aria-label="차트 개별 설정" className="topbar-settings-pill" data-open={activeSection !== null || undefined}>
          <button type="button" className="topbar-pill-btn" aria-label="지표" aria-haspopup={opensDialog ? "dialog" : undefined} aria-expanded={activeSection === "indicators"} title={keyTitle("지표", keys, "indicators")} onClick={() => toggleSection("indicators")}>
            <IndicatorIcon />
            <span className="topbar-label-lg">지표</span>
            {indicatorCount > 0 && <span className="topbar-pill-count">{indicatorCount}</span>}
          </button>
          <span className="topbar-pill-div" aria-hidden="true" />
          <button type="button" className="topbar-pill-btn" aria-label="비교" aria-haspopup={opensDialog ? "dialog" : undefined} aria-expanded={activeSection === "compare"} title="비교 종목" onClick={() => toggleSection("compare")}>
            <CompareIcon />
            <span className="topbar-label-lg">비교</span>
            {compareCount > 0 && <span className="topbar-pill-count">{compareCount}</span>}
          </button>
          <span className="topbar-pill-div" aria-hidden="true" />
          <button type="button" className="topbar-pill-btn" aria-label="차트 설정" aria-haspopup="dialog" aria-expanded={activeSection === "settings"} title="차트 설정" onClick={() => toggleSection("settings")}>
            <SlidersIcon />
            <span className="topbar-label-xl">차트 설정</span>
          </button>
        </div>
      </div>
      <div className="topbar-search-slot">
        <button type="button" className="shell-search" aria-haspopup="dialog" aria-label="종목·지표·명령 찾기" title={searchTitle(keys)} onClick={() => openSearch()}>
          <SearchIcon size={14} />
          <span className="shell-search-symbol">
            <b title={name}>{name}</b>
            <span>{symbolSub(cell.symbol, info)}</span>
          </span>
          <span className="shell-search-hint">종목·지표·명령 찾기</span>
          {keys.search?.slice(0, 2).map((key) => <kbd key={key}>{keyCapsLabel(key)}</kbd>)}
        </button>
        <TopbarClock />
      </div>
      <div className="topbar-zone" data-zone="workspace">
        <AutoGuardBadge />
        <BookReplayToggle />
        <LayoutMenu />
        <ArrangeMenu />
        <AddWindowMenu />
      </div>
    </header>
  );
}
