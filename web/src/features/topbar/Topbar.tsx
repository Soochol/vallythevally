import { Fragment } from "react";
import { useSymbolInfo } from "../../api/queries";
import { shownScale } from "../../chart/settings";
import { periodKey } from "../../lib/hotkeys";
import { PERIOD_LABEL, PERIODS, symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useTheme, useUiStore } from "../../stores/ui";
import { AXIS_LOCKED, LOG_LOCKED, pressScale } from "../indicator-dialog/compareForm";
import { BrandIcon, CameraIcon, CopyIcon, IndicatorIcon, MoonIcon, SearchIcon, SunIcon } from "../icons";
import { canCopyImage, saveSnapshot } from "../snapshot/saveSnapshot";
import { VenuePicker } from "../venue/VenuePicker";
import { StyleMenu } from "./StyleMenu";

const AXIS_BTN = "tb-btn disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

/** 위쪽 막대(frontend.md §2.1). 종목, 거래소(주식만), 봉 주기, 봉 모양, 로그·% 축, 지표, 차트 이미지, 테마. */
export function Topbar() {
  const slot = useSelectionStore((s) => s.activeSlot);
  const openSearch = useSelectionStore((s) => s.openSearch);
  const openIndicators = useSelectionStore((s) => s.openIndicators);
  const cell = useCell(slot);
  const info = useSymbolInfo(cell.symbol).data;
  const { setPeriod, setStyle, setScale } = useLayoutStore.getState();
  const theme = useTheme();
  const toggle = useUiStore((s) => s.toggleTheme);
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
      className="flex min-w-0 items-center gap-1 border-b border-line bg-bg pr-2 [grid-area:top] max-md:hidden"
    >
      <span className="grid w-[var(--tools-w)] flex-none place-items-center text-accent" title="vallythevally">
        <BrandIcon />
      </span>
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
      {cell.venue !== null && (
        <>
          <span className="tb-sep" />
          <VenuePicker cell={cell} info={info} variant="desktop" />
        </>
      )}
      <span className="tb-sep" />
      <div role="group" aria-label="봉 주기" className="-m-[3px] inline-flex min-w-0 items-center gap-px overflow-x-auto p-[3px] [scrollbar-width:none]">
        {PERIODS.map((p) => (
          <Fragment key={p}>
            {p === "D" && <span className="w-1.5 flex-none" />}
            <button
              type="button"
              className="seg-btn flex-none"
              aria-pressed={cell.period === p}
              title={periodKey(p) ? `${PERIOD_LABEL[p]} (${periodKey(p)})` : PERIOD_LABEL[p]}
              onClick={() => setPeriod(slot, p)}
            >
              {PERIOD_LABEL[p]}
            </button>
          </Fragment>
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
      <button type="button" className="icon-btn" title="테마 바꾸기" aria-label="테마 바꾸기" onClick={toggle}>
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
    </header>
  );
}
