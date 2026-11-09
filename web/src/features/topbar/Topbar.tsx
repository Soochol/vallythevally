import { Fragment } from "react";
import { useSymbolInfo } from "../../api/queries";
import { periodKey } from "../../lib/hotkeys";
import { PERIOD_LABEL, PERIODS, symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useThemeStore } from "../../stores/theme";
import { BrandIcon, MoonIcon, SearchIcon, SunIcon } from "../icons";
import { VenuePicker } from "../venue/VenuePicker";
import { StyleMenu } from "./StyleMenu";

/** 위쪽 막대(frontend.md §2.1). 종목, 거래소(주식만), 봉 주기, 봉 모양, 로그 축, 테마. */
export function Topbar() {
  const slot = useSelectionStore((s) => s.activeSlot);
  const openDialog = useSelectionStore((s) => s.openDialog);
  const cell = useCell(slot);
  const info = useSymbolInfo(cell.symbol).data;
  const { setPeriod, setStyle, setScale } = useLayoutStore.getState();
  const { theme, toggle } = useThemeStore();
  const log = cell.chartSettings.scale === "log";

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
        onClick={() => openDialog("search")}
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
      <div role="group" aria-label="봉 주기" className="inline-flex items-center gap-px">
        {PERIODS.map((p) => (
          <Fragment key={p}>
            {p === "D" && <span className="w-1.5" />}
            <button
              type="button"
              className="seg-btn"
              aria-pressed={cell.period === p}
              title={`${PERIOD_LABEL[p]} (${periodKey(p)})`}
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
        className="tb-btn"
        aria-pressed={log}
        title="로그 축 (L)"
        onClick={() => setScale(slot, log ? "normal" : "log")}
      >
        로그
      </button>
      <span className="flex-1" />
      <button type="button" className="icon-btn" title="테마 바꾸기" aria-label="테마 바꾸기" onClick={toggle}>
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
    </header>
  );
}
