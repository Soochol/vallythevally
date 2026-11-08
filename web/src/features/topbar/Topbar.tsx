import { useSymbolInfo } from "../../api/queries";
import { PERIOD_LABEL, PERIODS_ON, symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useThemeStore } from "../../stores/theme";
import { BrandIcon, MoonIcon, SearchIcon, SunIcon } from "../icons";
import { StyleMenu } from "./StyleMenu";

const PERIOD_KEY = { D: "D", W: "W", M: "M" } as const;

/** 위쪽 막대(frontend.md §2.1). #2에서는 종목, 봉 주기 일·주·월, 봉 모양, 로그 축, 테마만 켠다. */
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
      <span className="tb-sep" />
      <div role="group" aria-label="봉 주기" className="inline-flex items-center gap-px">
        {PERIODS_ON.map((p) => (
          <button
            key={p}
            type="button"
            className="seg-btn"
            aria-pressed={cell.period === p}
            title={`${PERIOD_LABEL[p]} (${PERIOD_KEY[p]})`}
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
