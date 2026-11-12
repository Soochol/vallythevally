import { MinuteMenu } from "./MinuteMenu";
import { useSymbolInfo } from "../../api/queries";
import { shownScale } from "../../chart/settings";
import { periodKey } from "../../lib/hotkeys";
import { PERIOD_LABEL, PERIODS, symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { AXIS_LOCKED, LOG_LOCKED, pressScale } from "../indicator-dialog/compareForm";
import { BrandIcon, CameraIcon, CopyIcon, IndicatorIcon, SearchIcon } from "../icons";
import { canCopyImage, saveSnapshot } from "../snapshot/saveSnapshot";
import { VenuePicker } from "../venue/VenuePicker";
import { StyleMenu } from "./StyleMenu";

const AXIS_BTN = "tb-btn disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

export function Topbar() {
  const slot = useSelectionStore((s) => s.activeSlot);
  const openSearch = useSelectionStore((s) => s.openSearch);
  const openIndicators = useSelectionStore((s) => s.openIndicators);
  const cell = useCell(slot);
  const info = useSymbolInfo(cell.symbol).data;
  const { setPeriod, setStyle, setScale } = useLayoutStore.getState();
  const desktopView = useSelectionStore((s) => s.desktopView);
  const setDesktopView = useSelectionStore((s) => s.setDesktopView);
  const shown = shownScale(cell.chartSettings);
  const locked = cell.chartSettings.compare.length > 0;
  const press = (button: "log" | "percent") => {
    const next = pressScale(cell.chartSettings, button);
    if (next) setScale(slot, next);
  };

  return (
    <header
      role="toolbar"
      aria-label="차트 도구 막대"
      className="flex min-w-0 flex-col border-b border-line bg-bg [grid-area:top] max-md:hidden"
    >
      <div className="app-header w-full">
        <span className="app-brand" title="vallythevally"><BrandIcon /><span>vally</span></span>
        <nav className="app-nav" aria-label="주 메뉴">
          <button type="button" aria-pressed={desktopView === "chart"} onClick={() => setDesktopView("chart")}>차트</button>
          <button type="button" aria-pressed={desktopView === "screener"} onClick={() => setDesktopView("screener")}>스크리너</button>
        </nav>
        <button
          type="button"
          className="tb-btn min-w-[168px] justify-start border border-line bg-surface"
          aria-haspopup="dialog"
          title="종목 검색 (/ 또는 Ctrl+K)"
          onClick={() => openSearch()}
        >
          <SearchIcon />
          <b className="font-semibold">{info?.name ?? cell.symbol}</b>
          <span className="text-s text-text-3">{symbolSub(cell.symbol, info)}</span>
          <kbd className="ml-auto">/</kbd>
        </button>
      </div>
      {desktopView === "chart" && (
        <div className="app-tools w-full overflow-x-auto overflow-y-hidden">
          {cell.venue !== null && (
            <>
              <span className="tb-sep" />
              <VenuePicker cell={cell} info={info} variant="desktop" />
            </>
          )}
          <span className="tb-sep" />
          <div role="group" aria-label="봉 주기" className="-m-[3px] inline-flex min-w-0 items-center gap-px overflow-x-auto p-[3px] [scrollbar-width:none]">
            <MinuteMenu value={cell.period} onChange={(period) => setPeriod(slot, period)} />
            {PERIODS.filter((p) => !p.endsWith("m")).map((p) => (
              <button
                key={p}
                type="button"
                className="seg-btn flex-none"
                aria-pressed={cell.period === p}
                title={periodKey(p) ? `${PERIOD_LABEL[p]} (${periodKey(p)})` : PERIOD_LABEL[p]}
                onClick={() => setPeriod(slot, p)}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
          <span className="tb-sep" />
          <StyleMenu value={cell.chartSettings.style} onChange={(s) => setStyle(slot, s)} />
          <button
            type="button"
            className={AXIS_BTN}
            aria-pressed={shown === "log"}
            disabled={locked}
            title={locked ? LOG_LOCKED : "로그 축 (L)"}
            onClick={() => press("log")}
          >
            로그
          </button>
          <button
            type="button"
            className={AXIS_BTN}
            aria-pressed={shown === "percent"}
            disabled={locked}
            title={locked ? AXIS_LOCKED : "가격축을 화면 왼쪽 끝 봉 기준 % 변화로"}
            onClick={() => press("percent")}
          >
            %
          </button>
          <span className="tb-sep" />
          <button type="button" className="tb-btn" aria-haspopup="dialog" title="지표 (I)" onClick={() => openIndicators(slot)}>
            <IndicatorIcon />
            지표
          </button>
          <span className="tb-sep" />
          <button
            type="button"
            className="icon-btn"
            title="차트 이미지 내려받기 (Alt+S)"
            aria-label="차트 이미지 내려받기"
            onClick={() => saveSnapshot(slot, "download")}
          >
            <CameraIcon />
          </button>
          {canCopyImage() && (
            <button
              type="button"
              className="icon-btn"
              title="차트 이미지 복사 (Alt+Shift+S)"
              aria-label="차트 이미지 복사"
              onClick={() => saveSnapshot(slot, "copy")}
            >
              <CopyIcon />
            </button>
          )}
          <span className="flex-1" />
        </div>
      )}
    </header>
  );
}
