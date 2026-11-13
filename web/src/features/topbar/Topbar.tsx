import { useRef, useState } from "react";
import { ChartSettingsPopover } from "../chart-settings/ChartSettingsPopover";
import { FinancialUpdateButton } from "../financial-update/FinancialUpdateButton";
import { MinuteMenu } from "./MinuteMenu";
import { periodKey } from "../../lib/hotkeys";
import { useSymbolInfo } from "../../api/queries";
import { PERIOD_LABEL, PERIODS, symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { openIndicatorCommand } from "../indicator-command/open";
import { BrandIcon, ChevronIcon, CameraIcon, CopyIcon, IndicatorIcon, SearchIcon, SlidersIcon, CompareIcon } from "../icons";
import { canCopyImage, saveSnapshot } from "../snapshot/saveSnapshot";

export function Topbar() {
  const slot = useSelectionStore((s) => s.activeSlot);
  const openSearch = useSelectionStore((s) => s.openSearch);
  const cell = useCell(slot);
  const opensDialog = useUiStore((s) => s.prefs.indicatorWindow) === "dialog";
  const info = useSymbolInfo(cell.symbol).data;
  const { setPeriod } = useLayoutStore.getState();
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header role="toolbar" aria-label="차트 도구 막대" className="desktop-topbar ui-island absolute left-[var(--island-gap)] right-[var(--island-right)] top-[var(--island-gap)] z-20 h-[var(--island-h)] rounded-l max-md:hidden">
      <span className="app-brand" title="vallythevally"><BrandIcon /><span>vally</span></span>
      <button type="button" className="tb-btn shell-symbol" aria-haspopup="dialog" title="종목 바꾸기" onClick={() => openSearch()}>
        <b className="truncate font-semibold">{info?.name ?? cell.symbol}</b>
        <span className="text-s text-text-3">{symbolSub(cell.symbol, info)}</span>
        <ChevronIcon />
      </button>
      <span className="tb-sep" />
      <div role="group" aria-label="봉 주기" className="flex flex-none items-center gap-px">
        <MinuteMenu value={cell.period} onChange={(period) => setPeriod(slot, period)} />
        {PERIODS.filter((p) => !p.endsWith("m")).map((p) => (
          <button key={p} type="button" className="seg-btn" aria-pressed={cell.period === p}
            title={periodKey(p) ? `${PERIOD_LABEL[p]} (${periodKey(p)})` : PERIOD_LABEL[p]} onClick={() => setPeriod(slot, p)}>{PERIOD_LABEL[p]}</button>
        ))}
      </div>
      <span className="tb-sep" />
      <button type="button" className="tb-btn" aria-haspopup={opensDialog ? "dialog" : undefined} title="지표 (I)" onClick={() => openIndicatorCommand(slot)}><IndicatorIcon />지표</button>
      <button type="button" className="tb-btn" aria-haspopup={opensDialog ? "dialog" : undefined} title="비교 종목" onClick={() => openIndicatorCommand(slot, "compare")}><CompareIcon />비교</button>
      <span className="min-w-0 flex-1" />
      <FinancialUpdateButton />
      <button type="button" className="icon-btn" title="차트 이미지 내려받기 (Alt+S)" aria-label="차트 이미지 내려받기" onClick={() => saveSnapshot(slot, "download")}><CameraIcon /></button>
      {canCopyImage() && <button type="button" className="icon-btn" title="차트 이미지 복사 (Alt+Shift+S)" aria-label="차트 이미지 복사" onClick={() => saveSnapshot(slot, "copy")}><CopyIcon /></button>}
      <button ref={settingsButton} type="button" className="tb-btn aria-expanded:bg-accent-soft aria-expanded:font-semibold aria-expanded:text-accent" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><SlidersIcon />차트 설정</button>
      {settingsOpen && <ChartSettingsPopover slot={slot} anchor={settingsButton} onClose={() => setSettingsOpen(false)} />}
      <button type="button" className="tb-btn shell-search" aria-haspopup="dialog" aria-label="종목·지표·명령 찾기" title="종목 검색 (/ 또는 Ctrl+K)" onClick={() => openSearch()}>
        <SearchIcon size={14} />
        <kbd>/</kbd>
      </button>
    </header>
  );
}
