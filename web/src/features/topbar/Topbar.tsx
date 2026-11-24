import { useRef, useState } from "react";
import { ChartSettingsDialog } from "../chart-settings/ChartSettingsDialog";
import { BrandLink } from "../page-rail/BrandLink";
import { MinuteMenu } from "./MinuteMenu";
import { MockBadge } from "./MockBadge";
import { keyCapsLabel, keyTitle, periodActionId, searchTitle } from "../../lib/hotkeys";
import { useSymbolInfo } from "../../api/queries";
import { PERIOD_LABEL, PERIODS, symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useActionKeys } from "../../stores/ui";
import { openIndicatorCommand, useShownIndicatorWindow } from "../indicator-command/open";
import { IndicatorIcon, MoreIcon, SearchIcon, SlidersIcon, CompareIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { ArrangeMenu } from "../layouts/ArrangeMenu";
import { LayoutMenu } from "../layouts/LayoutMenu";
import { VenuePicker } from "../venue/VenuePicker";
import { SystemButton } from "../system-settings/SystemButton";
import { AddWindowMenu } from "../workspace/AddWindowMenu";
import { BookReplayToggle } from "../book-replay/BookReplayToggle";

export function Topbar() {
  const cellId = useSelectionStore((s) => s.activeCell);
  const openSearch = useSelectionStore((s) => s.openSearch);
  const cell = useCell(cellId);
  const opensDialog = useShownIndicatorWindow() === "dialog";
  const info = useSymbolInfo(cell.symbol).data;
  const name = info?.name ?? cell.symbol;
  const { setPeriod } = useLayoutStore.getState();
  const keys = useActionKeys();
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const moreRoot = useRef<HTMLDivElement>(null);
  const visibleSettingsAnchorRect = () => (settingsButton.current?.getClientRects().length ? settingsButton.current : moreRoot.current)?.getBoundingClientRect();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreItems: MenuItem[] = [
    { kind: "action", label: "비교", icon: <CompareIcon />, onSelect: () => openIndicatorCommand(cellId, "compare") },
    { kind: "action", label: "차트 설정", icon: <SlidersIcon />, onSelect: () => setSettingsOpen(true) },
  ];

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
            <button key={p} type="button" className="seg-btn" aria-pressed={cell.period === p}
              title={keyTitle(PERIOD_LABEL[p], keys, periodActionId(p))} onClick={() => setPeriod(cellId, p)}>{PERIOD_LABEL[p]}</button>
          ))}
        </div>
        <button type="button" className="tb-btn" aria-label="지표" aria-haspopup={opensDialog ? "dialog" : undefined} title={keyTitle("지표", keys, "indicators")} onClick={() => openIndicatorCommand(cellId)}><IndicatorIcon /><span className="topbar-label-lg">지표</span></button>
        <button type="button" className="tb-btn topbar-fold" aria-label="비교" aria-haspopup={opensDialog ? "dialog" : undefined} title="비교 종목" onClick={() => openIndicatorCommand(cellId, "compare")}><CompareIcon /><span className="topbar-label-lg">비교</span></button>
        <button ref={settingsButton} type="button" className="tb-btn topbar-fold aria-expanded:bg-accent-soft aria-expanded:font-semibold aria-expanded:text-accent" aria-label="차트 설정" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><SlidersIcon /><span className="topbar-label-xl">차트 설정</span></button>
        <div ref={moreRoot} className="topbar-more">
          <button type="button" className="tb-btn aria-expanded:bg-accent-soft aria-expanded:text-accent" aria-label="더 보기" aria-haspopup="menu" aria-expanded={moreOpen} title="더 보기" onClick={() => setMoreOpen((open) => !open)}><MoreIcon /></button>
          {moreOpen && <Menu label="더 보기" root={moreRoot} items={moreItems} onClose={() => setMoreOpen(false)} />}
        </div>
        {settingsOpen && <ChartSettingsDialog cellId={cellId} anchor={settingsButton} anchorRect={visibleSettingsAnchorRect} onClose={() => setSettingsOpen(false)} />}
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
      </div>
      <div className="topbar-zone" data-zone="workspace">
        <BookReplayToggle />
        <LayoutMenu />
        <ArrangeMenu />
        <AddWindowMenu />
        <span className="tb-sep" />
        <SystemButton />
      </div>
    </header>
  );
}
