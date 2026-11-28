import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fetchBarsPage } from "../../api/bars";
import { useFinancials } from "../../api/financials";
import type { Bar } from "../../api/generated/Bar";
import type { Period } from "../../api/generated/Period";
import type { ProgramSeriesPage } from "../../api/generated/ProgramSeriesPage";
import type { QuoteTotalsPage } from "../../api/generated/QuoteTotalsPage";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useSymbolInfo, useSymbolInfos } from "../../api/queries";
import type { History } from "../../chart/barFeed";
import { type CellStatus, ChartController } from "../../chart/ChartController";
import type { IndicatorCommand } from "../../chart/indicators/legendRows";
import { nextIndicatorAxis, resolvePanelScales } from "../../chart/indicators/scales";
import { financialRequest } from "../../chart/indicators/shown";
import {
  type ChartSettings,
  DEFAULT_CHART_SETTINGS,
  type IndicatorConfig,
  parseChartSettings,
} from "../../chart/settings";
import { readThemeTokens } from "../../chart/theme";
import { windowId, type WindowId } from "../../layout/kinds";
import { shownVenue } from "../../lib/venue";
import { appliedThemeKey, DEFAULT_THEME_KEY, subscribeTheme } from "../../persist/theme";
import { type ChartWindowState, findChartCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { AxisMode } from "../grid/AxisMode";
import { chartDockLayoutFor, ChartRightDock } from "../indicator-command/ChartRightDock";
import { useShownSettings } from "../indicator-command/preview";
import { IndicatorPopover } from "../indicator-dialog/IndicatorPopover";
import { removeIndicatorWithUndo } from "../indicator-inspector/removalUndo";
import { ChartDockToggle } from "../workspace/ChartDockToggle";
import type { CanvasPalette } from "./canvasTheme";
import {
  aggregateReplayBars,
  REPLAY_CHART_TIMEFRAMES,
  type ReplayChartTimeframe,
} from "./replayChartModel";
import { ReplayChartExtension } from "./replayChartOverlay";
import type { ReplayEngine, ReplayEngineFrame } from "./replayEngine";
import type { ReplaySession } from "./replayModel";
import type { ReplayPaperEngine } from "./replayPaperEngine";

export const REPLAY_CHART_CELL_ID: WindowId = windowId("replay-chart");
const REPLAY_CHART_SETTINGS_KEY = "vally:replay-chart-settings";

const TIMEFRAME_TO_PERIOD: Readonly<Record<ReplayChartTimeframe, Period>> = {
  1: "1m",
  3: "3m",
  5: "5m",
  10: "10m",
  15: "15m",
  30: "30m",
};

interface Props {
  readonly code: SymbolCode;
  readonly session: ReplaySession;
  readonly engine: ReplayEngine;
  readonly paper?: ReplayPaperEngine;
  readonly blindMode: boolean;
  readonly bookmarks: readonly number[];
  readonly palette: CanvasPalette;
  readonly onScrub: (sec: number) => void;
}

function loadReplayChartSettings(): ChartSettings {
  try {
    const raw = window.localStorage.getItem(REPLAY_CHART_SETTINGS_KEY);
    if (!raw) return DEFAULT_CHART_SETTINGS;
    return parseChartSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CHART_SETTINGS;
  }
}

function saveReplayChartSettings(settings: ChartSettings): void {
  try {
    window.localStorage.setItem(REPLAY_CHART_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
  }
}

function canCreateCanvasChart(): boolean {
  if (typeof document === "undefined") return false;
  try {
    return document.createElement("canvas").getContext("2d") !== null;
  } catch {
    return false;
  }
}

function runReplayIndicatorCommand(cellId: WindowId, id: string, command: IndicatorCommand): void {
  const store = useLayoutStore.getState();
  const cell = findChartCell(store, cellId);
  const config = cell?.chartSettings.indicators.find((i) => i.id === id);
  if (!cell || !config) return;
  switch (command) {
    case "edit":
      return;
    case "collapse":
      return store.togglePanel(cellId, config.panel);
    case "toggle":
      return store.updateIndicator(cellId, id, { visible: !config.visible });
    case "remove":
      return removeIndicatorWithUndo(cellId, config);
    case "up":
    case "down":
      return store.movePanel(cellId, config.panel, command === "up" ? -1 : 1);
    case "split": {
      const panelIndex = config.panel === "price" ? -1 : cell.chartSettings.panels.findIndex((p) => p.id === config.panel);
      return store.splitIndicatorToNewPanel(cellId, id, panelIndex < 0 ? 0 : panelIndex + 1);
    }
    case "axis": {
      if (config.panel === "price") return;
      const scales = resolvePanelScales(cell.chartSettings.indicators, config.panel);
      const currentSlot = scales.get(id)?.slot ?? "right";
      return store.setIndicatorAxis(cellId, id, nextIndicatorAxis(currentSlot));
    }
  }
}

function buildReplayHistory(
  priorBars: readonly Bar[],
  session: ReplaySession,
  timeframe: ReplayChartTimeframe,
  frame: ReplayEngineFrame,
  blindMode: boolean,
): { readonly history: History; readonly tailBar: Bar | null } {
  const curMin = Math.floor(frame.cursorMs / 60_000);
  const aggregated = aggregateReplayBars(session.minutes, timeframe, frame, curMin);
  const replayBars: Bar[] = [];
  for (const b of aggregated) {
    if (blindMode && b.isFuture) break;
    if (b.open === null || b.high === null || b.low === null || b.close === null) continue;
    replayBars.push({
      t: session.dayStartUnix + b.startMinute * 60,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume,
    });
  }
  const merged = priorBars.length > 0 ? priorBars.concat(replayBars) : replayBars;
  const tailBar = merged.length > 0 ? merged[merged.length - 1]! : null;
  return {
    history: { bars: merged, current: null, nextBefore: null },
    tailBar,
  };
}

function buildSessionQuoteTotals(session: ReplaySession): QuoteTotalsPage {
  const points: QuoteTotalsPage["points"] = [];
  for (const m of session.minutes) {
    if (m.totalAsk === null || m.totalBid === null) continue;
    points.push({
      t: session.dayStartUnix + m.minute * 60,
      ask: m.totalAsk,
      bid: m.totalBid,
    });
  }
  return {
    available: points.length > 0,
    venue: "combined",
    days: [{ date: session.date, state: "closed" }],
    points,
  };
}

function buildSessionProgramSeries(session: ReplaySession, code: SymbolCode, period: Period): ProgramSeriesPage {
  const points: ProgramSeriesPage["points"] = [];
  for (const m of session.minutes) {
    if (m.programNetQty === null) continue;
    const netAmt = m.programNetAmtMillion ?? 0;
    points.push({
      t: session.dayStartUnix + m.minute * 60,
      netBuyQty: m.programNetQty,
      netBuyAmountMillionWon: netAmt,
      buyAmountMillionWon: Math.max(0, netAmt),
      sellAmountMillionWon: Math.max(0, -netAmt),
      programSharePct: null,
    });
  }
  return {
    symbol: code,
    period,
    state: points.length > 0 ? "ready" : "not_collected",
    points,
  };
}

function ensureReplayStandaloneCell(code: SymbolCode, period: Period, fallback: ChartWindowState): void {
  const store = useLayoutStore.getState();
  const existing = store.standaloneCharts[REPLAY_CHART_CELL_ID];
  if (existing) {
    if (existing.symbol !== code || existing.period !== period) {
      store.setStandaloneChart({ ...existing, symbol: code, period });
    }
    return;
  }
  store.setStandaloneChart({ ...fallback, symbol: code, period });
}

export function ReplayCharts({ code, session, engine, paper, blindMode, bookmarks, palette, onScrub }: Props) {
  const [timeframe, setTimeframe] = useState<ReplayChartTimeframe>(1);
  const period = TIMEFRAME_TO_PERIOD[timeframe];
  const [initialCell] = useState<ChartWindowState>(() => ({
    id: REPLAY_CHART_CELL_ID,
    kind: "chart",
    link: null,
    symbol: code,
    period,
    chartSettings: loadReplayChartSettings(),
  }));

  const standaloneCell = useLayoutStore((s) => s.standaloneCharts[REPLAY_CHART_CELL_ID]);
  const cell = standaloneCell ?? initialCell;

  useLayoutEffect(() => {
    ensureReplayStandaloneCell(code, period, initialCell);
  }, [code, period, initialCell]);
  const { settings: chartSettings, preview } = useShownSettings(REPLAY_CHART_CELL_ID, cell.chartSettings);
  const info = useSymbolInfo(code).data;
  const compareInfos = useSymbolInfos(cell.chartSettings.compare);
  const compareKey = compareInfos.map((i) => `${i.code}:${i.name}`).join("|");
  const compareNames = useMemo(() => Object.fromEntries(compareInfos.map((i) => [i.code, i.name])), [compareKey]);
  const finReq = financialRequest(period, chartSettings);
  const financial = useFinancials(code, finReq.period, finReq.enabled);
  const theme = useSyncExternalStore(subscribeTheme, () => appliedThemeKey(), () => DEFAULT_THEME_KEY);
  const cellDock = useSelectionStore((s) => (s.chartDock?.cellId === REPLAY_CHART_CELL_ID ? s.chartDock : null));

  const bodyRef = useRef<HTMLDivElement>(null);
  const chartElRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<ChartController | null>(null);
  const extRef = useRef<ReplayChartExtension | null>(null);
  const onScrubRef = useRef(onScrub);
  onScrubRef.current = onScrub;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const codeRef = useRef(code);
  codeRef.current = code;
  const priorBarsRef = useRef<readonly Bar[]>([]);
  const lastBarMetaRef = useRef<{ count: number; lastT: number | null; blind: boolean }>({
    count: -1,
    lastT: null,
    blind: blindMode,
  });

  const [status, setStatus] = useState<CellStatus>({ kind: "loading" });
  const [bodyWidth, setBodyWidth] = useState(0);
  const [corner, setCorner] = useState({ width: 72, height: 28 });
  const [editing, setEditing] = useState<{ initial: IndicatorConfig; anchor: HTMLElement } | null>(null);
  const [priorVersion, setPriorVersion] = useState(0);

  useEffect(() => {
    saveReplayChartSettings(cell.chartSettings);
  }, [cell.chartSettings]);

  useEffect(() => {
    return () => {
      if (useSelectionStore.getState().chartDock?.cellId === REPLAY_CHART_CELL_ID) {
        useSelectionStore.getState().closeChartDock();
      }
      useLayoutStore.getState().removeStandaloneChart(REPLAY_CHART_CELL_ID);
    };
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setBodyWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canCreateCanvasChart() || !chartElRef.current) return;
    const c = new ChartController(chartElRef.current, {
      tokens: readThemeTokens(),
      onStatus: setStatus,
      externalBars: true,
      fetchQuoteTotals: async () => buildSessionQuoteTotals(sessionRef.current),
      fetchProgramSeries: async (_symbol, reqPeriod) => buildSessionProgramSeries(sessionRef.current, codeRef.current, reqPeriod),
      onIndicatorCommand: (id, command, anchor) => {
        if (command !== "edit") return runReplayIndicatorCommand(REPLAY_CHART_CELL_ID, id, command);
        const selection = useSelectionStore.getState();
        if (selection.chartDock?.cellId === REPLAY_CHART_CELL_ID) {
          selection.openChartDock(REPLAY_CHART_CELL_ID, "current", id);
          return;
        }
        const initial = findChartCell(useLayoutStore.getState(), REPLAY_CHART_CELL_ID)?.chartSettings.indicators.find((i) => i.id === id);
        if (initial) setEditing((current) => (current?.initial.id === id ? current : { initial, anchor }));
      },
      onIndicatorMerge: (indicatorId, targetPanelId) =>
        useLayoutStore.getState().mergeIndicatorIntoPanel(REPLAY_CHART_CELL_ID, indicatorId, targetPanelId),
      onIndicatorSplit: (indicatorId, insertAt) =>
        useLayoutStore.getState().splitIndicatorToNewPanel(REPLAY_CHART_CELL_ID, indicatorId, insertAt),
      onPanelStretch: (stretches) => useLayoutStore.getState().setPanelStretches(REPLAY_CHART_CELL_ID, stretches),
      onCompareRemove: (cmpCode) => useLayoutStore.getState().removeCompare(REPLAY_CHART_CELL_ID, cmpCode),
      onCorner: setCorner,
    });
    ctlRef.current = c;
    const detach = c.attach((host) => {
      const ext = new ReplayChartExtension(host, (sec) => onScrubRef.current(sec));
      extRef.current = ext;
      return ext;
    });
    return () => {
      detach();
      extRef.current = null;
      c.dispose();
      ctlRef.current = null;
    };
  }, []);

  useEffect(() => {
    priorBarsRef.current = [];
    lastBarMetaRef.current = { count: -1, lastT: null, blind: blindMode };
    const ac = new AbortController();
    void fetchBarsPage({ symbol: code, venue: "combined", period, before: session.dayStartUnix }, ac.signal)
      .then((page) => {
        if (ac.signal.aborted) return;
        const beforeDay = page.bars.filter((b) => b.t < session.dayStartUnix);
        if (beforeDay.length > 0) {
          priorBarsRef.current = beforeDay;
          setPriorVersion((v) => v + 1);
        }
      })
      .catch(() => {
      });
    return () => ac.abort();
  }, [code, session.dayStartUnix, period]);

  useEffect(() => {
    ctlRef.current?.apply({
      symbol: code,
      venue: shownVenue(code, "combined", info),
      period,
      settings: chartSettings,
      info,
      previewIndicator: preview?.id ?? null,
      compareNames,
    });
    lastBarMetaRef.current = { count: -1, lastT: null, blind: blindMode };
  }, [code, period, chartSettings, info, preview, compareNames]);

  useEffect(() => {
    ctlRef.current?.setFinancials(financial.data ?? null, financial.error ? "재무자료 조회 실패" : undefined);
  }, [code, period, financial.data, financial.error]);

  useEffect(() => {
    ctlRef.current?.setTheme(readThemeTokens());
  }, [theme]);

  useEffect(() => {
    const baseMinute = session.minutes[0]?.minute ?? 540;

    const pushFrame = (frame: ReplayEngineFrame, forceReset: boolean) => {
      const ctl = ctlRef.current;
      if (ctl) {
        const { history, tailBar } = buildReplayHistory(priorBarsRef.current, session, timeframe, frame, blindMode);
        const count = history.bars.length;
        const lastT = tailBar?.t ?? null;
        const prev = lastBarMetaRef.current;
        const isFirstLoad = prev.count < 0;
        const sameTailSeries =
          !forceReset
          && !isFirstLoad
          && prev.blind === blindMode
          && prev.count === count
          && prev.lastT === lastT
          && tailBar !== null;

        lastBarMetaRef.current = { count, lastT, blind: blindMode };
        if (sameTailSeries) {
          ctl.updateExternalBar(history, tailBar);
        } else {
          ctl.setExternalHistory(history, { fit: isFirstLoad, preserveRange: !isFirstLoad });
        }
      }

      const holding = paper?.getHolding() ?? null;
      extRef.current?.setOverlay({
        dayStartUnix: session.dayStartUnix,
        timeframe,
        cursorSec: frame.cursorMs / 1000,
        blindMode,
        bookmarks,
        singlePriceWindows: session.singlePriceWindows,
        gapWindows: session.gapWindows,
        avgPrice: holding && holding.quantity > 0 && holding.avgPrice > 0 ? holding.avgPrice : null,
        fills: paper ? paper.getFills() : [],
        palette,
        baseMinute,
      });
    };

    pushFrame(engine.getFrame(), true);
    const unsubFrame = engine.subscribeFrame((frame) => pushFrame(frame, false));
    const unsubPaper = paper ? paper.subscribe(() => pushFrame(engine.getFrame(), false)) : undefined;
    return () => {
      unsubFrame();
      unsubPaper?.();
    };
  }, [session, engine, paper, timeframe, blindMode, bookmarks, palette, priorVersion, chartSettings]);

  const dockLayout = cellDock !== null ? chartDockLayoutFor(bodyWidth) : null;
  const chartBoxClass = dockLayout === "wide"
    ? "isolate absolute inset-y-0 left-0 right-[var(--size-320)]"
    : dockLayout === "compact"
      ? "isolate absolute inset-y-0 left-0 right-[var(--size-268)]"
      : "isolate absolute inset-0";

  return (
    <section className="rp-col rp-chart-col" aria-label="차트">
      <div className="mw-head rp-chart-head">
        <div className="ui-seg" data-size="sm" role="group" aria-label="분봉 주기" data-testid="replay-chart-timeframe">
          {REPLAY_CHART_TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              className="ui-seg-item"
              aria-pressed={timeframe === tf}
              onClick={() => setTimeframe(tf)}
            >
              {`${tf}분`}
            </button>
          ))}
        </div>
        <div className="rp-pane-controls">
          {standaloneCell && <ChartDockToggle id={REPLAY_CHART_CELL_ID} />}
        </div>
      </div>

      <div
        ref={bodyRef}
        data-chart-overlay-host=""
        className="rp-chart-body"
        data-testid="replay-main-chart"
        data-timeframe={String(timeframe)}
        onDoubleClick={() => ctlRef.current?.fitRange()}
      >
        <div ref={chartElRef} className={chartBoxClass} />
        {status.kind === "ready" && <AxisMode cellId={REPLAY_CHART_CELL_ID} corner={corner} />}
        {editing && chartElRef.current && cell.chartSettings.indicators.some((i) => i.id === editing.initial.id) && (
          <IndicatorPopover
            key={editing.initial.id}
            cellId={REPLAY_CHART_CELL_ID}
            {...editing}
            editRoot={chartElRef.current}
            onClose={() => setEditing(null)}
          />
        )}
        <ChartRightDock cellId={REPLAY_CHART_CELL_ID} hostRef={bodyRef} hideDrawings />
      </div>
    </section>
  );
}
