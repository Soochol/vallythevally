import { ErrorState, EmptyState, Skeleton } from "../overlay/State";
import { createPortal } from "react-dom";
import { VenuePicker } from "../venue/VenuePicker";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFinancials } from "../../api/financials";
import { isFinancial } from "../../chart/indicators/kinds";
import { useSymbolInfo, useSymbolInfos } from "../../api/queries";
import { type CellStatus, ChartController } from "../../chart/ChartController";
import type { IndicatorCommand } from "../../chart/indicators/legendRows";
import { readThemeTokens } from "../../chart/theme";
import { PERIOD_LABEL } from "../../lib/symbol";
import { shownVenue, venueLabel } from "../../lib/venue";
import { NXT_FALLBACK_NOTICE } from "../../persist/restore";
import { type Slot, useCell, useLayoutStore } from "../../stores/layout";
import { marketSocket } from "../../stores/realtime";
import { useSelectionStore } from "../../stores/selection";
import { useTheme } from "../../stores/ui";
import { cellErrorView, olderErrorView } from "./cellError";
import { useDrawingSurface } from "../../chart/drawings/useDrawingSurface";
import { IndicatorPopover } from "../indicator-dialog/IndicatorPopover";
import type { IndicatorConfig } from "../../chart/settings";
import { DrawingOverlay } from "../drawings/DrawingOverlay";
import { attachController } from "./controllers";

function runIndicatorCommand(slot: Slot, id: string, command: IndicatorCommand): void {
  const store = useLayoutStore.getState();
  const config = store.layout.cells.find((c) => c.slot === slot)?.chartSettings.indicators.find((i) => i.id === id);
  if (!config) return;
  switch (command) {
    case "refresh":
      return;
    case "edit":
      return;
    case "collapse":
      return store.togglePanel(slot, config.panel);
    case "toggle":
      return store.updateIndicator(slot, id, { visible: !config.visible });
    case "remove":
      return store.removeIndicator(slot, id);
    case "up":
    case "down":
      return store.movePanel(slot, config.panel, command === "up" ? -1 : 1);
  }
}

interface Props {
  slot: Slot;
  status: CellStatus;
  onStatus: (s: CellStatus) => void;
}

/** 컨트롤러를 붙였다 떼는 얇은 컴포넌트. 봉 데이터는 props로 받지 않는다(frontend.md §5.4). */
export function ChartCell({ slot, status, onStatus }: Props) {
  const cell = useCell(slot);
  const info = useSymbolInfo(cell.symbol).data;
  const venue = shownVenue(cell.venue, info);
  const compareInfos = useSymbolInfos(cell.chartSettings.compare);
  const compareKey = compareInfos.map((i) => `${i.code}:${i.name}`).join("|");
  const compareNames = useMemo(() => Object.fromEntries(compareInfos.map((i) => [i.code, i.name])), [compareKey]);
  const financial = useFinancials(cell.symbol, cell.period === "Y" ? "Y" : "Q", (cell.period === "Q" || cell.period === "Y") && cell.chartSettings.indicators.some((i) => isFinancial(i.spec) && i.visible));
  const refreshFinancial = useRef(financial.refresh);
  refreshFinancial.current = financial.refresh;
  const theme = useTheme();
  const openSearch = useSelectionStore((s) => s.openSearch);
  const chartEl = useRef<HTMLDivElement>(null);
  const ctl = useRef<ChartController | null>(null);
  const [editing, setEditing] = useState<{ initial: IndicatorConfig; anchor: HTMLElement } | null>(null);
  const [venueAnchor, setVenueAnchor] = useState<HTMLElement | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const slotRef = useRef(slot);
  slotRef.current = slot;

  useEffect(() => {
    const c = new ChartController(chartEl.current!, {
      tokens: readThemeTokens(),
      onStatus: (s) => onStatusRef.current(s),
      socket: marketSocket,
      onIndicatorCommand: (id, command, anchor) => {
        if (command === "refresh") return refreshFinancial.current();
        if (command !== "edit") return runIndicatorCommand(slotRef.current, id, command);
        const initial = useLayoutStore.getState().layout.cells.find((c) => c.slot === slotRef.current)?.chartSettings.indicators.find((i) => i.id === id);
        if (initial) setEditing({ initial, anchor });
      },
      onPanelStretch: (stretches) => useLayoutStore.getState().setPanelStretches(slotRef.current, stretches),
      onCompareRemove: (code) => useLayoutStore.getState().removeCompare(slotRef.current, code),
    });
    ctl.current = c;
    setVenueAnchor(c.venueAnchor);
    return () => {
      c.dispose();
      ctl.current = null;
    };
  }, []);

  useEffect(() => attachController(slot, ctl.current!), [slot]);

  useEffect(() => {
    ctl.current?.apply({ symbol: cell.symbol, venue, period: cell.period, settings: cell.chartSettings, info, compareNames });
  }, [cell, venue, info, compareNames]);

  useEffect(() => {
    ctl.current?.setFinancials(financial.data ?? null, financial.error || financial.refreshError ? "재무자료 조회·갱신 실패 · 새로고침으로 다시 시도하세요" : financial.refreshing ? "재무자료 갱신 요청 중" : undefined);
  }, [cell.symbol, cell.period, financial.data, financial.error, financial.refreshError, financial.refreshing]);

  // 복원 때 종목 정보를 못 받아 확인하지 못한 NXT가 나중에 NXT 불가로 확인되면, 그때 저장 원본을 고친다.
  // 그대로 두면 다음 저장을 서버가 400으로 거절한다.
  useEffect(() => {
    if (info?.code === cell.symbol && cell.venue === "nxt" && !info.nxtEnabled) {
      useLayoutStore.getState().setVenue(slot, "combined");
      useSelectionStore.getState().showToast(NXT_FALLBACK_NOTICE);
    }
  }, [info, cell.symbol, cell.venue, slot]);

  useEffect(() => {
    ctl.current?.setTheme(readThemeTokens());
  }, [theme]);

  useDrawingSurface(ctl, slot);

  const name = info?.name ?? cell.symbol;
  const error = status.kind === "error" ? cellErrorView(status.error, cell.symbol) : null;
  const olderError = status.kind === "ready" && status.olderError ? olderErrorView(status.olderError, cell.symbol) : null;

  return (
    <section
      tabIndex={0}
      aria-label={`칸 ${slot + 1}: ${[name, venueLabel(cell.symbol, venue), PERIOD_LABEL[cell.period]].filter(Boolean).join(" ")}`}
      aria-busy={status.kind === "loading"}
      className="relative min-h-0 min-w-0 bg-chart-bg focus-visible:outline-offset-[-2px]"
    >
      <div ref={chartEl} className="absolute inset-0" />
      {venueAnchor && createPortal(<VenuePicker cell={cell} info={info} variant="legend" />, venueAnchor)}
      <DrawingOverlay slot={slot} />
      {editing && cell.chartSettings.indicators.some((i) => i.id === editing.initial.id) && <IndicatorPopover key={editing.initial.id} slot={slot} {...editing} onClose={() => setEditing(null)} />}
      {status.kind === "loading" && <div className="pointer-events-none absolute inset-0 z-[5] bg-chart-bg"><Skeleton label="차트 불러오는 중" /></div>}
      {olderError && (
        <div
          role="alert"
          className="absolute left-2 top-1/2 z-[5] flex max-w-[min(44ch,calc(100%-96px))] -translate-y-1/2 flex-col items-start gap-2 rounded-m border border-warning bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] px-3 py-2 text-s text-text shadow-dialog"
        >
          <p>{olderError.text}</p>
          {olderError.retry && (
            <button type="button" className="btn-primary" onClick={() => ctl.current?.retryOlder()}>
              다시 시도
            </button>
          )}
        </div>
      )}
      {status.kind === "ready" && status.olderLoading && (
        <div className="pointer-events-none absolute left-2 top-1/2 z-[5] rounded-m bg-surface px-3 py-2 text-s text-text-2 shadow-dialog" role="status">
          과거 봉을 불러오는 중입니다
        </div>
      )}
      {status.kind === "ready" && status.intradayEnd && (
        <div
          role="status"
          className="absolute left-2 top-1/2 z-[5] flex max-w-[min(44ch,calc(100%-96px))] -translate-y-1/2 flex-col items-start gap-2 rounded-m border border-line bg-surface px-3 py-2 text-s text-text-2 shadow-dialog"
        >
          <p>분봉은 최근 1년까지 볼 수 있습니다. 더 과거는 일봉으로 보세요</p>
          <button type="button" className="tb-btn border border-line" onClick={() => useLayoutStore.getState().setPeriod(slot, "D")}>
            일봉으로 보기
          </button>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-[5] grid place-items-center bg-chart-bg p-6">
          {error.action === "retry" ? <ErrorState message={error.text} retry={() => ctl.current?.reload()} /> : <div role="alert"><EmptyState title={error.text} action={error.action === "search" ? "종목 검색" : undefined} onAction={openSearch} /></div>}
        </div>
      )}
    </section>
  );
}
