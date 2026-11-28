import { createPortal } from "react-dom";
import { VenueFallbackBadge } from "../venue/VenuePicker";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFinancials } from "../../api/financials";
import { financialRequest } from "../../chart/indicators/shown";
import { useSymbolInfo, useSymbolInfos } from "../../api/queries";
import { type CellStatus, ChartController } from "../../chart/ChartController";
import type { IndicatorCommand } from "../../chart/indicators/legendRows";
import { nextIndicatorAxis, resolvePanelScales } from "../../chart/indicators/scales";
import { crosshairGroupKey, crosshairSync } from "../../chart/crosshairSync";
import { readThemeTokens } from "../../chart/theme";
import { isMinutePeriod, PERIOD_LABEL } from "../../lib/symbol";
import { shownVenue, venueLabel } from "../../lib/venue";
import { chartNumber, chartWindows, useCell, useLayoutStore } from "../../stores/layout";
import { marketSocket } from "../../stores/realtime";
import { useSelectionStore } from "../../stores/selection";
import { openIndicatorBubble, toggleIndicatorAdd } from "../indicator-command/open";
import { removeIndicatorWithUndo } from "../indicator-inspector/removalUndo";
import { appliedThemeKey, DEFAULT_THEME_KEY, subscribeTheme } from "../../persist/theme";
import { useVenue } from "../../stores/ui";
import { matchesSnapTarget, useChartPointerStore } from "../../stores/chartPointer";
import { replayPointScheduler } from "../book-replay/pointScheduler";
import { useBookReplayEnabled } from "../book-replay/useBookReplay";
import { useTickReplayMatch } from "../tick-replay/scope";
import { type CellAction, cellErrorView, olderErrorView } from "./cellError";
import { CellState } from "./CellState";
import { openSystemSettings } from "../system-settings/open";
import { NOT_CONNECTED_FALLBACK, beforeConnect } from "../status/beforeConnect";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { BeforeConnectCard } from "../status/BeforeConnectCard";
import { useDrawingSurface } from "../../chart/drawings/useDrawingSurface";
import { useAutoGuardLayer } from "../../chart/autoGuard/useAutoGuardLayer";
import { useShownSettings } from "../indicator-command/preview";
import { AxisMode } from "./AxisMode";
import { DrawingOverlay } from "../drawings/DrawingOverlay";
import { useWindowVisible } from "../workspace/windowVisibility";
import { attachController } from "./controllers";
import type { WindowId } from "../../layout/kinds";

function runIndicatorCommand(cellId: WindowId, id: string, command: Exclude<IndicatorCommand, "edit">): void {
  const store = useLayoutStore.getState();
  const cell = chartWindows(store.layout).find((c) => c.id === cellId);
  const config = cell?.chartSettings.indicators.find((i) => i.id === id);
  if (!cell || !config) return;
  switch (command) {
    case "collapse":
      return store.togglePanel(cellId, config.panel);
    case "toggle":
      return store.updateIndicator(cellId, id, { visible: !config.visible });
    case "remove":
      return removeIndicatorWithUndo(cellId, config);
    case "axis": {
      if (config.panel === "price") return;
      const slot = resolvePanelScales(cell.chartSettings.indicators, config.panel).get(id)?.slot ?? "right";
      return store.setIndicatorAxis(cellId, id, nextIndicatorAxis(slot));
    }
  }
}

interface Props {
  cellId: WindowId;
  status: CellStatus;
  onStatus: (s: CellStatus) => void;
}

/** 컨트롤러를 붙였다 떼는 얇은 컴포넌트. 봉 데이터는 props로 받지 않는다(frontend.md §5.4). */
export function ChartCell({ cellId, status, onStatus }: Props) {
  const cell = useCell(cellId);
  const layoutId = useLayoutStore((s) => s.layout.id);
  const layoutSession = useLayoutStore((s) => s.session);
  const crosshairScope = useLayoutStore((s) => s.layout.sync.crosshair ? s.layout.sync.crosshairScope : null);
  const { settings: chartSettings, preview } = useShownSettings(cellId, cell.chartSettings);
  const info = useSymbolInfo(cell.symbol).data;
  const appVenue = useVenue();
  const venue = shownVenue(cell.symbol, appVenue, info);
  const compareInfos = useSymbolInfos(cell.chartSettings.compare);
  const compareKey = compareInfos.map((i) => `${i.code}:${i.name}`).join("|");
  const compareNames = useMemo(() => Object.fromEntries(compareInfos.map((i) => [i.code, i.name])), [compareKey]);
  const request = financialRequest(cell.period, chartSettings);
  const financial = useFinancials(cell.symbol, request.period, request.enabled);
  const theme = useSyncExternalStore(subscribeTheme, () => appliedThemeKey(), () => DEFAULT_THEME_KEY);
  const replayEnabled = useBookReplayEnabled();
  const tickReplay = useTickReplayMatch(cellId, cell.symbol);
  const pointerSnap = useChartPointerStore((s) => s.snap);
  const lastSnapSeq = useRef(0);
  const openSearch = useSelectionStore((s) => s.openSearch);
  const windowVisible = useWindowVisible();
  const sectionEl = useRef<HTMLElement>(null);
  const chartEl = useRef<HTMLDivElement>(null);
  const badgeHostEl = useRef<HTMLDivElement>(null);
  const ctl = useRef<ChartController | null>(null);
  const [corner, setCorner] = useState({ width: 72, height: 28 });
  const [venueAnchor, setVenueAnchor] = useState<HTMLElement | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const cellIdRef = useRef(cellId);
  cellIdRef.current = cellId;

  const chartInsetClass = "absolute inset-0";
  const chartBoxClass = `isolate ${chartInsetClass}`;
  const badgeHostClass = `pointer-events-none ${chartInsetClass} ${status.kind === "ready" ? "z-[6]" : "z-[15]"}`;

  useEffect(() => {
    const c = new ChartController(chartEl.current!, {
      tokens: readThemeTokens(),
      onStatus: (s) => onStatusRef.current(s),
      socket: marketSocket,
      badgeHost: badgeHostEl.current!,
      onIndicatorCommand: (id, command, anchor, field) => {
        if (command !== "edit") return runIndicatorCommand(cellIdRef.current, id, command);
        openIndicatorBubble(cellIdRef.current, id, anchor, field ?? null);
      },
      onIndicatorAdd: (anchor) => toggleIndicatorAdd(cellIdRef.current, anchor),
      onIndicatorMerge: (indicatorId, targetPanelId) => useLayoutStore.getState().mergeIndicatorIntoPanel(cellIdRef.current, indicatorId, targetPanelId),
      onIndicatorSplit: (indicatorId, insertAt) => useLayoutStore.getState().splitIndicatorToNewPanel(cellIdRef.current, indicatorId, insertAt),
      onPanelStretch: (stretches) => useLayoutStore.getState().setPanelStretches(cellIdRef.current, stretches),
      onCompareRemove: (code) => useLayoutStore.getState().removeCompare(cellIdRef.current, code),
      onCorner: setCorner,
    });
    ctl.current = c;
    setVenueAnchor(c.venueAnchor);
    return () => {
      c.dispose();
      ctl.current = null;
    };
  }, []);

  useEffect(() => attachController(cellId, ctl.current!), [cellId]);

  useEffect(() => {
    ctl.current?.setActive(windowVisible);
  }, [windowVisible]);

  useEffect(() => {
    if (crosshairScope === null || !ctl.current || !chartEl.current) return;
    const key = crosshairGroupKey(crosshairScope, `${layoutSession}:${layoutId}`, cell);
    if (key === null) return;
    return crosshairSync.connect(key, ctl.current, chartEl.current);
  }, [cellId, layoutId, layoutSession, crosshairScope, cell.symbol, cell.link]);

  useEffect(() => {
    if (!replayEnabled) replayPointScheduler.cancel();
    if (!replayEnabled || !ctl.current) return;
    const symbol = cell.symbol;
    return ctl.current.subscribePointedBar((bar, close) => {
      if (bar === null) return;
      replayPointScheduler.push(symbol, bar, close);
    });
  }, [replayEnabled, cell.symbol]);

  useEffect(() => {
    ctl.current?.apply({ symbol: cell.symbol, venue, period: cell.period, settings: chartSettings, info, previewIndicator: preview?.id ?? null, compareNames });
  }, [cell, chartSettings, venue, info, preview, compareNames]);

  useEffect(() => {
    const controller = ctl.current;
    if (!controller) return;
    if (tickReplay !== null && isMinutePeriod(cell.period) && tickReplay.session !== null && tickReplay.engine !== null) {
      controller.setTickReplay({
        session: tickReplay.session,
        engine: tickReplay.engine,
        isArchive: tickReplay.isArchive,
      });
    } else {
      controller.setTickReplay(null);
    }
  }, [tickReplay?.session, tickReplay?.engine, tickReplay?.isArchive, cell.period]);

  useEffect(() => {
    if (!pointerSnap) return;
    if (lastSnapSeq.current === pointerSnap.seq) return;
    if (!matchesSnapTarget(pointerSnap.target, cellId, cell.link)) {
      lastSnapSeq.current = pointerSnap.seq;
      return;
    }
    if (pointerSnap.symbol !== cell.symbol || status.kind !== "ready" || !ctl.current) return;
    if (ctl.current.snapCrosshair(pointerSnap.symbol, pointerSnap.bar)) {
      lastSnapSeq.current = pointerSnap.seq;
    }
  }, [pointerSnap, cell.symbol, cell.link, cellId, status.kind]);

  useEffect(() => {
    ctl.current?.setFinancials(financial.data ?? null, financial.error ? "재무자료 조회 실패" : undefined);
  }, [cell.symbol, cell.period, financial.data, financial.error]);

  useEffect(() => {
    ctl.current?.setTheme(readThemeTokens());
  }, [theme]);

  useDrawingSurface(ctl, cellId);
  useAutoGuardLayer(ctl);

  const cellNumber = useLayoutStore((s) => chartNumber(s.layout, cellId));
  const name = info?.name ?? cell.symbol;
  const link = useKiwoomLinkStore((s) => s.status);
  const refusedBeforeConnect = status.kind === "error" && status.error.reason === "not_connected";
  const notice = beforeConnect(link) ?? (refusedBeforeConnect && link === null ? NOT_CONNECTED_FALLBACK : null);
  const connected = link?.state === "connected";
  const failedRef = useRef(false);
  failedRef.current = status.kind === "error";
  useEffect(() => {
    if (connected && failedRef.current) ctl.current?.reload();
  }, [connected]);
  const tickReplayAttached =
    tickReplay !== null && isMinutePeriod(cell.period) && tickReplay.session !== null && tickReplay.engine !== null;
  const showLoading = status.kind === "loading" && !tickReplayAttached;
  const error = status.kind === "error" && notice === null && !tickReplayAttached ? cellErrorView(status.error, cell.symbol) : null;
  const runCellAction = (action: CellAction) => {
    if (action === "retry") ctl.current?.reload();
    else if (action === "search") openSearch();
    else openSystemSettings("kiwoom");
  };
  const olderError = status.kind === "ready" && status.olderError ? olderErrorView(status.olderError, cell.symbol) : null;

  return (
    <section
      ref={sectionEl}
      data-cell={cellId}
      tabIndex={0}
      aria-label={`칸 ${cellNumber}: ${[name, venueLabel(cell.symbol, venue), PERIOD_LABEL[cell.period]].filter(Boolean).join(" ")}`}
      aria-busy={showLoading}
      className="relative min-h-0 min-w-0 flex-1 bg-chart-bg focus-visible:outline-offset-[-2px]"
    >
      <div ref={chartEl} className={chartBoxClass} />
      {status.kind === "ready" && <AxisMode cellId={cellId} corner={corner} />}
      {venueAnchor && venue !== null && venue !== appVenue && createPortal(<VenueFallbackBadge />, venueAnchor)}
      <DrawingOverlay cellId={cellId} />
      {showLoading && <div role="status" aria-label="차트 불러오는 중" className="pointer-events-none absolute inset-0 z-[15] grid place-items-center bg-chart-bg"><span className="chart-loading-label text-s text-text-3">차트 불러오는 중</span></div>}
      {olderError && (
        <div
          role="alert"
          className="absolute left-2 top-1/2 z-[15] flex max-w-[min(44ch,calc(100%-96px))] -translate-y-1/2 flex-col items-start gap-2 rounded-m border border-warning bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] px-3 py-2 text-s text-text shadow-dialog"
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
        <div className="pointer-events-none absolute left-2 top-1/2 z-[15] rounded-m bg-surface px-3 py-2 text-s text-text-2 shadow-dialog" role="status">
          과거 봉을 불러오는 중입니다
        </div>
      )}
      {status.kind === "ready" && status.intradayEnd && (
        <div
          role="status"
          className="absolute left-2 top-1/2 z-[15] flex max-w-[min(44ch,calc(100%-96px))] -translate-y-1/2 flex-col items-start gap-2 rounded-m border border-line bg-surface px-3 py-2 text-s text-text-2 shadow-dialog"
        >
          <p>분봉은 최근 1년까지 볼 수 있습니다. 더 과거는 일봉으로 보세요</p>
          <button type="button" className="btn btn-sm" onClick={() => useLayoutStore.getState().setPeriod(cellId, "D")}>
            일봉으로 보기
          </button>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-[15] grid place-items-center bg-chart-bg p-6">
          <CellState view={error} onAction={runCellAction} />
        </div>
      )}
      <div ref={badgeHostEl} className={badgeHostClass} />
      {notice && <BeforeConnectCard notice={notice} />}
    </section>
  );
}
