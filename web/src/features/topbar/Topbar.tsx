import { BrandLink } from "../page-rail/BrandLink";
import { MinuteMenu } from "./MinuteMenu";
import { MockBadge } from "./MockBadge";
import { keyCapsLabel, keyTitle, periodActionId, searchTitle } from "../../lib/hotkeys";
import { useSymbolInfo } from "../../api/queries";
import { PERIOD_LABEL, PERIODS, symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useActionKeys } from "../../stores/ui";
import { toggleChartSettings, toggleIndicatorAdd } from "../indicator-command/open";
import { PlusIcon, SearchIcon, SlidersIcon } from "../icons";
import { ArrangeMenu } from "../layouts/ArrangeMenu";
import { LayoutMenu } from "../layouts/LayoutMenu";
import { VenuePicker } from "../venue/VenuePicker";
import { AddWindowMenu } from "../workspace/AddWindowMenu";
import { BookReplayToggle } from "../book-replay/BookReplayToggle";
import { AutoGuardBadge } from "./AutoGuardBadge";
import { TopbarClock } from "./TopbarClock";

export function Topbar() {
  const cellId = useSelectionStore((s) => s.activeCell);
  const openSearch = useSelectionStore((s) => s.openSearch);
  const chartPop = useSelectionStore((s) => s.chartPop);
  const cell = useCell(cellId);
  const info = useSymbolInfo(cell.symbol).data;
  const name = info?.name ?? cell.symbol;
  const { setPeriod } = useLayoutStore.getState();
  const keys = useActionKeys();

  const openHere = chartPop?.cellId === cellId ? chartPop.kind : null;
  const addedCount = cell.chartSettings.indicators.length + cell.chartSettings.compare.length;

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
        <div role="group" aria-label="차트 개별 설정" className="topbar-settings-pill" data-open={openHere === "add" || openHere === "settings" || undefined}>
          <button type="button" className="topbar-pill-btn" data-chart-pop-opener="add" aria-label="지표" aria-haspopup="dialog" aria-expanded={openHere === "add"} title={keyTitle("지표", keys, "indicators")} onClick={(event) => toggleIndicatorAdd(cellId, event.currentTarget)}>
            <PlusIcon size={14} />
            <span className="topbar-label-lg">지표</span>
            {addedCount > 0 && <span className="topbar-pill-count">{addedCount}</span>}
          </button>
          <span className="topbar-pill-div" aria-hidden="true" />
          <button type="button" className="topbar-pill-btn" data-chart-pop-opener="settings" aria-label="차트 설정" aria-haspopup="dialog" aria-expanded={openHere === "settings"} title="차트 설정" onClick={(event) => toggleChartSettings(cellId, event.currentTarget)}>
            <SlidersIcon />
            <span className="topbar-label-lg">차트</span>
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
