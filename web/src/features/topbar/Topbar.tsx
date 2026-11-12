import { FinancialUpdateButton } from "../financial-update/FinancialUpdateButton";
import { MinuteMenu } from "./MinuteMenu";
import { shownScale } from "../../chart/settings";
import { periodKey } from "../../lib/hotkeys";
import { PERIOD_LABEL, PERIODS } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { AXIS_LOCKED, LOG_LOCKED, pressScale } from "../indicator-dialog/compareForm";
import { BrandIcon, CameraIcon, CopyIcon, GearIcon, IndicatorIcon, PanelIcon, SearchIcon, CompareIcon } from "../icons";
import { canCopyImage, saveSnapshot } from "../snapshot/saveSnapshot";
import { StyleMenu } from "./StyleMenu";

const AXIS_BTN = "tb-btn disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

export function Topbar() {
  const slot = useSelectionStore((s) => s.activeSlot);
  const openSearch = useSelectionStore((s) => s.openSearch);
  const openIndicatorCommand = useSelectionStore((s) => s.openIndicatorCommand);
  const collapsed = useUiStore((s) => s.prefs.watchCollapsed);
  const cell = useCell(slot);
  const { setPeriod, setStyle, setScale } = useLayoutStore.getState();
  const shown = shownScale(cell.chartSettings);
  const locked = cell.chartSettings.compare.length > 0;
  const press = (button: "log" | "percent") => {
    const next = pressScale(cell.chartSettings, button);
    if (next) setScale(slot, next);
  };

  return (
    <header role="toolbar" aria-label="차트 도구 막대" className="desktop-topbar border-b border-line bg-bg [grid-area:top] max-md:hidden">
      <span className="app-brand" title="vallythevally"><BrandIcon /><span>vally</span></span>
      <button type="button" className="tb-btn shell-search" aria-haspopup="dialog" title="종목 검색 (/ 또는 Ctrl+K)" onClick={() => openSearch()}>
        <SearchIcon size={14} />
        <span className="truncate text-s text-text-3">종목·지표·명령 찾기</span>
        <kbd className="ml-auto">/</kbd>
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
      <StyleMenu value={cell.chartSettings.style} onChange={(s) => setStyle(slot, s)} />
      <button type="button" className="tb-btn" aria-haspopup="dialog" title="지표 (I)" onClick={() => openIndicatorCommand(slot)}><IndicatorIcon />지표</button>
      <button type="button" className="tb-btn" aria-haspopup="dialog" title="비교 종목" onClick={() => openIndicatorCommand(slot, "compare")}><CompareIcon />비교</button>
      <span className="tb-sep" />
      <button type="button" className={AXIS_BTN} aria-pressed={shown === "log"} disabled={locked} title={locked ? LOG_LOCKED : "로그 축 (L)"} onClick={() => press("log")}>로그</button>
      <button type="button" className={AXIS_BTN} aria-pressed={shown === "percent"} disabled={locked} title={locked ? AXIS_LOCKED : "가격축을 화면 왼쪽 끝 봉 기준 % 변화로"} onClick={() => press("percent")}>%</button>
      <span className="min-w-0 flex-1" />
      <FinancialUpdateButton />
      <button type="button" className="icon-btn" title="차트 이미지 내려받기 (Alt+S)" aria-label="차트 이미지 내려받기" onClick={() => saveSnapshot(slot, "download")}><CameraIcon /></button>
      {canCopyImage() && <button type="button" className="icon-btn" title="차트 이미지 복사 (Alt+Shift+S)" aria-label="차트 이미지 복사" onClick={() => saveSnapshot(slot, "copy")}><CopyIcon /></button>}
      <button type="button" className="icon-btn" title="차트 설정" aria-label="차트 설정" aria-haspopup="dialog" onClick={() => openIndicatorCommand(slot)}><GearIcon /></button>
      {collapsed && <button type="button" className="icon-btn" title="패널 펴기 (Alt+W)" aria-label="패널 펴기" aria-expanded={false} onClick={() => useUiStore.getState().toggleWatch()}><PanelIcon /></button>}
    </header>
  );
}
