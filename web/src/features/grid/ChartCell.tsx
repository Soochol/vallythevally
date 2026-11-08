import { useEffect, useRef } from "react";
import { useSymbolInfo } from "../../api/queries";
import { type CellStatus, ChartController } from "../../chart/ChartController";
import { readThemeTokens } from "../../chart/theme";
import { PERIOD_LABEL } from "../../lib/symbol";
import { type Slot, useCell } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useThemeStore } from "../../stores/theme";
import { cellErrorView } from "./cellError";

interface Props {
  slot: Slot;
  status: CellStatus;
  onStatus: (s: CellStatus) => void;
}

/** 컨트롤러를 붙였다 떼는 얇은 컴포넌트. 봉 데이터는 props로 받지 않는다(frontend.md §5.4). */
export function ChartCell({ slot, status, onStatus }: Props) {
  const cell = useCell(slot);
  const info = useSymbolInfo(cell.symbol).data;
  const theme = useThemeStore((s) => s.theme);
  const openDialog = useSelectionStore((s) => s.openDialog);
  const chartEl = useRef<HTMLDivElement>(null);
  const ctl = useRef<ChartController | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    const c = new ChartController(chartEl.current!, {
      tokens: readThemeTokens(),
      onStatus: (s) => onStatusRef.current(s),
    });
    ctl.current = c;
    return () => {
      c.dispose();
      ctl.current = null;
    };
  }, []);

  useEffect(() => {
    ctl.current?.apply({ symbol: cell.symbol, period: cell.period, settings: cell.chartSettings, info });
  }, [cell, info]);

  useEffect(() => {
    ctl.current?.setTheme(readThemeTokens());
  }, [theme]);

  const name = info?.name ?? cell.symbol;
  const error = status.kind === "error" ? cellErrorView(status.error, cell.symbol) : null;

  return (
    <section
      tabIndex={0}
      aria-label={`칸 ${slot + 1}: ${name} ${PERIOD_LABEL[cell.period]}`}
      aria-busy={status.kind === "loading"}
      className="relative min-h-0 min-w-0 bg-chart-bg focus-visible:outline-offset-[-2px]"
    >
      <div ref={chartEl} className="absolute inset-0" />
      {status.kind === "loading" && (
        <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center">
          <p className="rounded-m bg-surface px-3 py-2 text-s text-text-2 shadow-dialog" role="status">
            봉을 불러오는 중입니다
          </p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-[5] grid place-items-center bg-chart-bg p-6">
          <div className="flex max-w-[44ch] flex-col items-center gap-4 text-center" role="alert">
            <p className="text-m text-text">{error.text}</p>
            {error.action === "search" && (
              <button type="button" className="btn-primary" onClick={() => openDialog("search")}>
                종목 검색
              </button>
            )}
            {error.action === "retry" && (
              <button type="button" className="btn-primary" onClick={() => ctl.current?.reload()}>
                다시 시도
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
