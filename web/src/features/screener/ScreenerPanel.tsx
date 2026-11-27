import { PANEL_MENU, SentenceEditor } from "./SentenceEditor";
import { useScreenEditing } from "./useScreenEditing";
import { CHANGED, ChangedBadge } from "./ChangedBadge";
import { type ChosenScreen, FIX_INVALID, type ScreenEditing, type ScreenEntry } from "./screenEditing";
import { confirmAction } from "../overlay/Confirm";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import type { ApiErrorBody } from "../../api/generated/ApiErrorBody";
import type { KstDate } from "../../api/generated/KstDate";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import type { ScreenerStatus } from "../../api/generated/ScreenerStatus";
import type { ScreenerUpdate } from "../../api/generated/ScreenerUpdate";
import type { Screens } from "../../api/generated/Screens";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UpdatePhase } from "../../api/generated/UpdatePhase";
import { useScreenerStatus, useUpdateCommands } from "../../api/screener";
import { useFeedBeforeConnect } from "../status/beforeConnect";
import { SCREENER_REFRESH_TOOLTIP, useScreenerRefreshNeedsKiwoom } from "../status/marketFeed";
import { isTypingTarget } from "../../lib/typingTarget";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import {
  dayLabel,
  excludedText,
  isUpdating,
  PHASE_LABEL,
  type RunBlock,
  runBlock,
  SCREENER_QUICK_PRESETS,
  type ScreenerQuickPreset,
  showsUpdateBand,
  sortRows,
  type StatusFooter,
  statusFooter,
  todayConfirmed,
  updateBandKind,
  type UpdateRetry,
  updateRetry,
} from "../../lib/screener";
import { draftOf } from "../screen-dialog/screenForm";
import { listNameFrom, MAX_WATCHLISTS } from "../../lib/watchlist";
import { useLayoutStore, watchedSymbol } from "../../stores/layout";
import { activeWatchWindow } from "../../stores/activeWindow";
import type { WindowId } from "../../layout/kinds";
import { type Rerun, rerunReason, type ScreenRun, shownResult, useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useWatchlistStore } from "../../stores/watchlist";
import { ChevronIcon, CloseIcon, EmptyBoxIcon, InfoIcon, MoreIcon, PenIcon, PlayIcon, PlusIcon, SearchIcon, SpinnerIcon, WarningIcon } from "../icons";
import { OVERLAY_GAP, placeOverlay } from "../overlay/position";
import { Skeleton } from "../overlay/State";
import { Badge } from "../ui/Badge";
import { Menu, type MenuItem } from "../menu/Menu";
import { ownsChartKeyboard } from "../overlay/topLayer";
import { DataAgeNote } from "../data-age/DataAgeNote";
import { RESULT_KEYS_HINT, ResultTable } from "./ResultTable";
import { ScreenerColumnPicker } from "./ScreenerColumnPicker";
import { dropPendingOpen, openResult, openResultInCell, pendingResultCode, sendToNewWatchlist, sendToWatchlist } from "./resultActions";
import { nextResult, resultKeyAction } from "./results";

const PANEL_POLL_MS = 1_000;
const RAIL_POLL_MS = 10_000;
const BADGE_MAX = 999;
const FULL_RELOAD_CONFIRM =
  "모든 종목의 전체 이력을 처음부터 다시 받습니다. 2시간 가까이 걸릴 수 있고, 최근 관측일을 채우는 동안에는 실행할 수 없습니다. 받는 동안에도 차트는 그대로 쓸 수 있습니다.";

const mountedWindows: WindowId[] = [];
let lastTouchedWindow: WindowId | null = null;
const ownsKeys = (id: WindowId | null) => {
  if (id === null) return true;
  const touched = lastTouchedWindow !== null && mountedWindows.includes(lastTouchedWindow);
  return (touched ? lastTouchedWindow : mountedWindows[0]) === id;
};
function useMountedWindow(id: WindowId | null) {
  useEffect(() => {
    if (id === null) return;
    mountedWindows.push(id);
    return () => {
      mountedWindows.splice(mountedWindows.indexOf(id), 1);
    };
  }, [id]);
}

const toast = (text: string) => useSelectionStore.getState().showToast(text);
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const showCommandError = (e: unknown) => toast(`업데이트 명령을 보내지 못했습니다: ${reasonOf(e)}`);
const openDialog = (window: WindowId | null) => useSelectionStore.getState().openScreenEditor(window);
const createInDialog = (screenEditing: ScreenEditing, window: WindowId | null) => {
  screenEditing.create();
  openDialog(window);
};
const count = (n: number) => n.toLocaleString("ko-KR");

function useStoreStatus(pollWhileUpdatingMs: number) {
  const query = useScreenerStatus(pollWhileUpdatingMs);
  const seeStatus = useScreenerStore((s) => s.seeStatus);
  useEffect(() => {
    if (query.data) seeStatus(query.data);
  }, [query.data, seeStatus]);
  return query;
}

function useWatchedSymbol(sender: WindowId | null): SymbolCode | null {
  const activeCell = useSelectionStore((s) => s.activeCell);
  return useLayoutStore((s) => watchedSymbol(s.layout, sender, activeCell, s.groupSymbols));
}

function useMenuToggle() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);
  return { open, toggle: () => setOpen((o) => !o), close, root, button };
}

export function ScreenerBadge({ id }: { id: WindowId | null }) {
  const updating = isUpdating(useStoreStatus(RAIL_POLL_MS).data);
  const shown = shownResult(useScreenEditing(id).view.chosen?.run ?? null)?.rows.length;
  if (updating) {
    return (
      <span className="text-accent">
        <SpinnerIcon size={10} />
        <span className="sr-only">업데이트 중</span>
      </span>
    );
  }
  if (shown === undefined) return null;
  return (
    <Badge>
      <span className="sr-only">결과 </span>
      {shown > BADGE_MAX ? `${BADGE_MAX}+` : shown}
      <span className="sr-only">종목</span>
    </Badge>
  );
}

export function PhoneScreener() {
  const shown = useSelectionStore((s) => s.phoneTab === "screener");
  const desktop = useMediaQuery(DESKTOP_QUERY);
  if (!shown || desktop) return null;
  return (
    <div className="fixed inset-x-0 bottom-[56px] top-0 z-30 flex flex-col bg-bg">
      <ScreenerPanel id={null} />
    </div>
  );
}

export function ScreenerPanel({ id }: { id: WindowId | null }) {
  const { editing: screenEditing, view, query: screens } = useScreenEditing(id);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const { chosen } = view;
  const screen = chosen?.screen ?? null;
  const run = chosen?.run ?? null;
  const statusQuery = useStoreStatus(PANEL_POLL_MS);
  const status = statusQuery.data;
  const block = status ? runBlock(status) : null;
  const sort = useScreenerStore((s) => s.sort);
  const result = shownResult(run);
  const rows = useMemo(() => (result ? sortRows(result.rows, sort) : []), [result, sort]);
  const [filterText, setFilterText] = useState("");
  const [onlyRising, setOnlyRising] = useState(false);
  const [onlyBothBuy, setOnlyBothBuy] = useState(false);
  const screenId = screen?.id ?? null;
  useEffect(() => {
    setFilterText("");
    setOnlyRising(false);
    setOnlyBothBuy(false);
  }, [screenId]);
  const filteredRows = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q && !onlyRising && !onlyBothBuy) return rows;
    return rows.filter((row) => {
      if (q && !row.name.toLowerCase().includes(q) && !row.symbol.toLowerCase().includes(q)) return false;
      if (onlyRising && (row.changeRate === null || row.changeRate <= 0)) return false;
      if (onlyBothBuy && !((row.programNetMillionWon ?? 0) > 0 && (row.whaleNetMillionWon ?? 0) > 0)) return false;
      return true;
    });
  }, [rows, filterText, onlyRising, onlyBothBuy]);
  const queryClient = useQueryClient();
  const active = useWatchedSymbol(id);
  const [editing, setEditing] = useState(false);
  const select = (code: SymbolCode) => void openResult(queryClient, code, id);
  const openInCell = (code: SymbolCode) => void openResultInCell(queryClient, code, id);
  const execute = () => {
    void screenEditing.run().then((outcome) => {
      if (outcome.kind === "invalid" && desktop) setEditing(true);
      else if (outcome.kind === "invalid") toast(FIX_INVALID);
      else if (outcome.kind === "failed") toast(outcome.message);
    });
  };
  const createInPanel = () => {
    screenEditing.create();
    setEditing(true);
  };
  const createPreset = (preset: ScreenerQuickPreset) => {
    screenEditing.create();
    screenEditing.edit(() => draftOf({ id: "", ...preset.screen }));
    if (desktop) setEditing(true);
    else openDialog(id);
  };
  const createScreen = desktop ? createInPanel : () => createInDialog(screenEditing, id);
  useMountedWindow(id);
  useResultKeys({ rows: filteredRows, active, onSelect: select, onRun: execute }, () => ownsKeys(id));
  useEffect(() => dropPendingOpen, []);
  const band = status !== undefined && showsUpdateBand(status);
  const offline = useFeedBeforeConnect() !== null;
  const resultFilter: ResultFilterState = {
    query: filterText,
    onlyRising,
    onlyBothBuy,
    onQuery: setFilterText,
    onToggleRising: () => setOnlyRising((v) => !v),
    onToggleBothBuy: () => setOnlyBothBuy((v) => !v),
    onReset: () => { setFilterText(""); setOnlyRising(false); setOnlyBothBuy(false); },
  };
  return (
    <aside aria-label="스크리너" data-chart-control className="flex min-h-0 min-w-0 flex-1 flex-col" onPointerDownCapture={() => { lastTouchedWindow = id; }} onFocusCapture={() => { lastTouchedWindow = id; }}>
      {offline && status?.lastDay && <p className="flex-none border-b border-line px-3 py-1.5 text-xs text-text-2">저장된 일봉 {status.lastDay.slice(5).replace("-", "/")}까지 · 오늘 시세는 연결 뒤에 합칩니다</p>}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="max-h-[50%] flex-none overflow-y-auto">
          {band && <UpdateBand status={status} />}
          {chosen && desktop ? (
            <SentenceEditor screenEditing={screenEditing} chosen={chosen} entries={view.entries} blocked={!status || block !== null} menu={(screenItems) => <PanelMenu screen={screen} rows={filteredRows} status={status} lead={screenItems} />} editing={editing} onEditingChange={setEditing} onRun={execute} />
          ) : chosen ? (
            <ScreenHeader windowId={id} screenEditing={screenEditing} chosen={chosen} entries={view.entries} block={block} status={status} rows={filteredRows} onRun={execute} />
          ) : (
            <header className="flex h-8 flex-none items-center gap-1 border-b border-line bg-[var(--strip-bg,var(--surface))] pl-3 pr-1.5">
              <h2 className="text-b font-[700]">스크리너</h2>
              <span className="flex-1" />
              <PanelMenu screen={null} rows={filteredRows} status={status} />
            </header>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {screen ? (
            <Results screen={screen} run={run} rows={rows} filteredRows={filteredRows} filter={resultFilter} status={status} block={block} onRun={execute} onEdit={desktop ? () => setEditing(true) : () => openDialog(id)} selected={active} onSelect={select} onOpenInCell={openInCell} />
          ) : (
            <NoScreen query={screens} onCreate={createScreen} onPreset={createPreset} />
          )}
        </div>
      </div>
      <StatusFooterLine footer={statusFooter(status, statusQuery.error)} status={status} onRetry={() => void statusQuery.refetch()} />
    </aside>
  );
}

interface ResultKeys {
  rows: readonly ScreenerRow[];
  active: SymbolCode | null;
  onSelect(code: SymbolCode): void;
  onRun(): void;
}

export type ScreenerKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented" | "target" | "preventDefault">;

export function handleResultKey(event: ScreenerKeyEvent, { rows, active, onSelect, onRun }: ResultKeys) {
  if (useSelectionStore.getState().dialog || ownsChartKeyboard(event) || isTypingTarget(event.target)) return;
  const action = resultKeyAction(event);
  if (!action) return;
  if (action.kind === "run") {
    event.preventDefault();
    onRun();
    return;
  }
  if (activeWatchWindow() !== null) return;
  const code = nextResult(rows, pendingResultCode() ?? active, action.step);
  if (rows.length) event.preventDefault();
  if (code) onSelect(code);
}

function useResultKeys({ rows, active, onSelect, onRun }: ResultKeys, owns: () => boolean) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (owns()) handleResultKey(event, { rows, active, onSelect, onRun });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, active, onSelect, onRun]);
}

interface HeaderProps {
  windowId: WindowId | null;
  screenEditing: ScreenEditing;
  chosen: ChosenScreen;
  entries: readonly ScreenEntry[];
  block: RunBlock | null;
  status: ScreenerStatus | undefined;
  rows: readonly ScreenerRow[];
  onRun(): void;
}

const BLOCK_HINT: Record<RunBlock, string> = {
  updating: "최근 관측일을 채우는 동안에는 실행할 수 없습니다",
  missing_day: "자료가 모자라 실행할 수 없습니다",
  empty: "받은 자료가 없어 실행할 수 없습니다",
};

function runHint(block: RunBlock | null, status: ScreenerStatus | undefined): ReactNode {
  if (block) return <span className="text-warning">{BLOCK_HINT[block]}</span>;
  if (!status?.lastDay) return null;
  return "실행할 때 KRX 최신 자료를 수집합니다";
}

function ScreenHeader({ windowId, screenEditing, chosen, entries, block, status, rows, onRun }: HeaderProps) {
  const { screen } = chosen;
  const running = chosen.run?.kind === "running";
  return (
    <header className="flex-none border-b border-line px-3 pb-3 pt-2">
      <div className="flex items-center gap-1">
        <ScreenPicker windowId={windowId} screenEditing={screenEditing} entries={entries} chosen={chosen} />
        {chosen.dirty && <ChangedBadge />}
        <span className="flex-1" />
        <button type="button" className="tb-btn h-7 gap-1 px-2 text-s text-text-2" title="조건식 편집" onClick={() => openDialog(windowId)}>
          <PenIcon size={14} />
          편집
        </button>
        <PanelMenu screen={screen} rows={rows} status={status} />
      </div>
      <div className="mt-2.5 flex items-center gap-2.5">
        <button
          type="button"
          className="btn-primary flex h-8 flex-none items-center gap-1.5 px-4 text-s disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!status || block !== null || running}
          aria-label={running ? "실행 중" : "실행"}
          title="실행 (Ctrl+↵)"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          onClick={onRun}
        >
          {running ? <SpinnerIcon /> : <PlayIcon />}
          {running ? "실행 중" : "실행"}<kbd className="ml-1 text-xs max-md:hidden">Ctrl+↵</kbd>
        </button>
        <span className="min-w-0 text-xs leading-[1.4] text-text-2">{runHint(block, status)}</span>
      </div>
    </header>
  );
}

function ScreenPicker({ windowId, screenEditing, entries, chosen }: { windowId: WindowId | null; screenEditing: ScreenEditing; entries: readonly ScreenEntry[]; chosen: ChosenScreen }) {
  const menu = useMenuToggle();
  const name = chosen.title;
  const items: MenuItem[] = [
    ...entries.map((entry): MenuItem => ({ kind: "radio", label: entry.title, hint: entry.dirty ? CHANGED : undefined, checked: entry.source.id === chosen.source.id, onSelect: () => { dropPendingOpen(); screenEditing.choose(entry.source.id); } })),
    { kind: "separator" },
    { kind: "action", label: "새 조건식…", onSelect: () => createInDialog(screenEditing, windowId) },
  ];
  return (
    <div ref={menu.root} className="relative -ml-1.5 min-w-0">
      <button
        ref={menu.button}
        type="button"
        title="조건식 고르기"
        aria-label={`조건식: ${name}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-m px-1.5 py-1 hover:bg-raised"
      >
        <span className="truncate text-l font-[600]">{name}</span>
        <ChevronIcon />
      </button>
      {menu.open && (
        <Menu label="조건식 고르기" items={items} onClose={menu.close} root={menu.root} className="absolute left-0 top-[calc(100%+4px)] max-h-[60vh] min-w-[240px] overflow-auto" />
      )}
    </div>
  );
}

function PanelMenu({ screen, rows, status, lead = [] }: { screen: Screen | null; rows: readonly ScreenerRow[]; status: ScreenerStatus | undefined; lead?: readonly MenuItem[] }) {
  const menu = useMenuToggle();
  const lists = useWatchlistStore((s) => s.lists);
  const { start } = useUpdateCommands();
  const retry = useUpdateRetry(status?.update?.error ?? null);
  const waiting = retry?.kind === "waiting" ? retry : null;
  const codes = rows.map((r) => r.symbol);
  const nothing = codes.length === 0;
  const fresh = screen ? listNameFrom(lists, screen.name) : null;
  const newList: MenuItem[] =
    fresh === null
      ? []
      : [{ kind: "action", label: `새 목록 "${fresh}"`, disabled: nothing || lists.length >= MAX_WATCHLISTS, onSelect: () => sendToNewWatchlist(fresh, codes) }];
  const offline = useFeedBeforeConnect() !== null;
  const needsKiwoom = useScreenerRefreshNeedsKiwoom();
  const reload = async () => {
    if (await confirmAction(FULL_RELOAD_CONFIRM, { action: "전체 다시 받기" })) void start(true).catch(showCommandError);
  };
  const items: MenuItem[] = [
    ...(lead.length ? [...lead, { kind: "separator" } satisfies MenuItem] : []),
    { kind: "heading", label: nothing ? "결과를 관심종목으로 보내기" : `결과 ${count(codes.length)}종목을 관심종목으로 보내기` },
    ...lists.map((l): MenuItem => ({ kind: "action", label: l.name, disabled: nothing, onSelect: () => sendToWatchlist(l.id, codes) })),
    ...newList,
    { kind: "separator" },
    { kind: "action", label: "전체 다시 받기…", hint: waiting?.from ?? (needsKiwoom ? SCREENER_REFRESH_TOOLTIP : undefined), disabled: isUpdating(status) || waiting !== null || offline || needsKiwoom, onSelect: reload },
  ];
  return (
    <div ref={menu.root} className="relative flex-none">
      <button
        ref={menu.button}
        type="button"
        className="icon-btn"
        title={lead.length ? "조건식 저장·이름 바꾸기, 관심종목으로 보내기, 전체 다시 받기" : "관심종목으로 보내기, 전체 다시 받기"}
        aria-label={PANEL_MENU}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <MoreIcon />
      </button>
      {menu.open && (
        <Menu label={PANEL_MENU} items={items} onClose={menu.close} root={menu.root} className="absolute right-0 top-[calc(100%+4px)] max-h-[60vh] min-w-[220px] overflow-auto" />
      )}
    </div>
  );
}

function StatePanel({ title, children, action, tone, icon, busy }: { title: string; children?: ReactNode; action?: ReactNode; tone?: "danger"; icon?: ReactNode; busy?: boolean }) {
  return (
    <div role={tone === "danger" ? "alert" : busy ? "status" : undefined} data-tone={tone} className="ui-state min-h-0 flex-1 justify-start pt-10">
      <span className="ui-state-icon">{icon ?? (tone === "danger" ? <WarningIcon size={24} /> : <EmptyBoxIcon />)}</span>
      <p className="ui-state-title">{title}</p>
      {children && <div className="ui-state-body">{children}</div>}
      {action}
    </div>
  );
}

function NoScreen({ query, onCreate, onPreset }: { query: UseQueryResult<Screens>; onCreate(): void; onPreset(preset: ScreenerQuickPreset): void }) {
  if (query.isPending) return <Skeleton label="조건식을 불러오는 중" rows={6} />;
  if (query.isError) {
    return (
      <StatePanel title="조건식을 불러오지 못했습니다" tone="danger" action={<RetryButton onClick={() => void query.refetch()} />}>
        {query.error.message}
      </StatePanel>
    );
  }
  return (
    <StatePanel
      title="저장한 조건식이 없습니다"
      action={
        <div className="flex flex-col items-center gap-2.5">
          <button type="button" className="btn-primary btn-sm" onClick={onCreate}>
            <PlusIcon size={14} />새 조건식
          </button>
          <div role="group" aria-label="추천 프리셋" className="flex max-w-[260px] flex-wrap justify-center gap-1">
            {SCREENER_QUICK_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="h-6 rounded-s border border-line bg-raised px-2 text-xs text-text-2 hover:border-accent hover:text-text"
                onClick={() => onPreset(preset)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      }
    >
      조건식에 이름과 조건을 정해 저장하면 여기서 골라 실행합니다.
    </StatePanel>
  );
}

function RetryButton({ onClick, label = RETRY, disabled = false }: { onClick(): void; label?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className="btn btn-sm flex-none" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

const RETRY = "다시 시도";
const KEPT_RESULT = "이전 결과를 그대로 보입니다";

const NOT_RUN: Record<RunBlock | "ready", { title: string; body: string }> = {
  ready: { title: "실행하면 결과가 여기에 나옵니다", body: `행을 누르거나 ↑↓로 결과를 차례로 칸에 엽니다. ${RESULT_KEYS_HINT}` },
  updating: { title: "최근 관측일을 채우고 있습니다", body: "끝나면 실행할 수 있습니다." },
  missing_day: { title: "새 자료가 필요합니다", body: "위에서 업데이트하면 빠진 관측일을 채웁니다." },
  empty: { title: "저장소가 비어 있습니다", body: "위에서 처음 받기를 누르면 KRX 일봉을 받습니다." },
};

interface ResultFilterState {
  query: string;
  onlyRising: boolean;
  onlyBothBuy: boolean;
  onQuery(value: string): void;
  onToggleRising(): void;
  onToggleBothBuy(): void;
  onReset(): void;
}

interface ResultsProps {
  screen: Screen;
  run: ScreenRun | null;
  rows: readonly ScreenerRow[];
  filteredRows: readonly ScreenerRow[];
  filter: ResultFilterState;
  status: ScreenerStatus | undefined;
  block: RunBlock | null;
  onRun(): void;
  onEdit(): void;
  selected: SymbolCode | null;
  onSelect(code: SymbolCode): void;
  onOpenInCell(code: SymbolCode): void;
}

function Results({ screen, run, rows, filteredRows, filter, status, block, onRun, onEdit, selected, onSelect, onOpenInCell }: ResultsProps) {
  const result = shownResult(run);
  const storeVersion = useScreenerStore((s) => s.storeVersion);
  const rerun = block === null ? rerunReason(run, storeVersion, status) : null;
  const failure = run?.kind === "failed" ? run : null;
  const message = failure?.error.reason === "data_changed"
    ? `수집 중 자료가 바뀌었습니다. ${failure.error.message}`
    : failure?.error.message;
  if (result) return (
    <>
      {failure && (
        <div role="alert" className="flex flex-none items-start gap-2 border-b border-line px-3 py-2">
          <span className="min-w-0 flex-1 text-s">
            <span className="block text-danger">실행하지 못했습니다: {message}</span>
            <span className="block text-xs text-text-2">{KEPT_RESULT}</span>
          </span>
          <RetryButton disabled={block !== null} onClick={onRun} />
        </div>
      )}
      <ResultList screen={screen} result={result} rows={rows} filteredRows={filteredRows} filter={filter} running={run?.kind === "running"} rerun={rerun} onRun={onRun} onEdit={onEdit} selected={selected} onSelect={onSelect} onOpenInCell={onOpenInCell} />
    </>
  );
  if (failure) return (
    <StatePanel title="실행하지 못했습니다" tone="danger" action={<RetryButton disabled={block !== null} onClick={onRun} />}>
      결과 없음. {message}
    </StatePanel>
  );
  if (run?.kind === "running") return <FirstRun universe={status?.fullHistory.total ?? null} />;
  const { title, body } = NOT_RUN[block ?? "ready"];
  return <StatePanel title={title}>{body}</StatePanel>;
}

function FirstRun({ universe }: { universe: number | null }) {
  const label = universe ? `찾는 중 · 대상 ${count(universe)}종목` : "찾는 중";
  return (
    <section aria-label="결과" aria-busy="true" className="flex flex-col">
      <p role="status" className="flex h-7 flex-none items-center gap-1.5 px-3 text-s text-text-2"><SpinnerIcon size={12} />{label}</p>
      <div aria-hidden="true" className="border-t border-line">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex h-[var(--row-h)] items-center gap-2 px-3">
            <span className="h-3 flex-1 rounded-s bg-raised" style={{ maxWidth: `${60 - (index % 3) * 12}%` }} />
            <span className="h-3 w-16 rounded-s bg-raised" />
            <span className="h-4 w-16 rounded-s bg-raised" />
          </div>
        ))}
      </div>
    </section>
  );
}

interface ResultListProps extends Omit<ResultsProps, "run" | "status" | "block"> {
  result: ScreenerResult;
  running: boolean;
  rerun: Rerun | null;
}

const collectionTime = (seconds: number) => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).format(new Date(seconds * 1000));

const RESULT_INFO = "수집 시각과 제외 내역";

function ResultInfo({ result }: { result: ScreenerResult }) {
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggle = () => {
    const node = pop.current;
    const anchor = button.current?.getBoundingClientRect();
    if (!node || !anchor) return;
    if (node.matches(":popover-open")) { node.hidePopover(); return; }
    node.showPopover();
    const place = placeOverlay(anchor, node.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, "bottom");
    node.style.left = `${Math.max(OVERLAY_GAP, Math.min(anchor.right - node.offsetWidth, place.left))}px`;
    node.style.top = `${place.top}px`;
  };
  return (
    <>
      <button ref={button} type="button" data-chart-control className="icon-btn h-[var(--ctl-xs)] w-[var(--ctl-xs)] flex-none" aria-label={RESULT_INFO} title={RESULT_INFO} aria-expanded={open} aria-describedby={id} onClick={toggle}>
        <InfoIcon size={14} />
      </button>
      <div ref={pop} id={id} popover="auto" role="tooltip" aria-label="결과 자료" className="ui-popover ui-tooltip" onToggle={(event) => setOpen((event.nativeEvent as ToggleEvent).newState === "open")}>
        <div className="space-y-1 text-xs leading-relaxed text-text-2">
          <p>기준 관측일 {result.asOf} · KRX</p>
          <p>수집 범위 (KST) <time>{collectionTime(result.collectionStartedAt)}</time> ~ <time>{collectionTime(result.collectionCompletedAt)}</time></p>
          <p>현재가는 일봉 0봉 가격 · 등락률은 직전 거래 일봉 대비</p>
          <p>잠정은 이번 수집의 당일 요약입니다</p>
          <p>자료 누락 {count(result.missingSummary)}종목{result.missingSummary > 0 && " · 자료를 확인하지 못해 판정에서 빠졌습니다"}</p>
          <p>대상 {count(result.universe)}종목 · 빠짐: {excludedText(result.excluded)}</p>
        </div>
      </div>
    </>
  );
}

function ResultList({ screen, result, rows, filteredRows, filter, running, rerun, onRun, onEdit, selected, onSelect, onOpenInCell }: ResultListProps) {
  const sort = useScreenerStore((s) => s.sort);
  const left = result.excluded.listedTooShort + result.excluded.historyShort;
  const hasFilter = filter.query.trim() !== "" || filter.onlyRising || filter.onlyBothBuy;
  const hasBothMicro = rows.some((row) => row.programNetMillionWon !== undefined) && rows.some((row) => row.whaleNetMillionWon !== undefined);
  return (
    <section aria-label="결과" aria-busy={running} className={`flex flex-col ${running ? "opacity-50" : ""}`}>
      <div className="flex h-7 flex-none items-center gap-1.5 pl-3 pr-1.5 text-s">
        <span className="flex-none whitespace-nowrap text-text-2">
          <span className="font-[600] text-text">{hasFilter ? `${count(filteredRows.length)} / ${count(rows.length)}` : count(rows.length)}종목</span> · {dayLabel(result.asOf, result.asOf)} 기준
        </span>
        <span className="min-w-0 flex-1 truncate text-right">
          <DataAgeNote recordedAt={result.collectionCompletedAt} cadence="screener" />
        </span>
        {rows.length > 0 && <ScreenerColumnPicker rows={rows} />}
        <ResultInfo result={result} />
      </div>
      {rows.length > 0 && (
        <div className="flex h-8 flex-none items-center gap-1 border-t border-line-subtle bg-bg px-2.5">
          <label className="relative flex min-w-0 flex-1 items-center">
            <span className="pointer-events-none absolute left-1.5 text-text-3"><SearchIcon size={12} /></span>
            <input
              type="search"
              aria-label="결과 내 검색"
              placeholder="종목명·코드"
              value={filter.query}
              onChange={(e) => filter.onQuery(e.target.value)}
              className="h-[var(--ctl-xs)] w-full min-w-0 rounded-s border border-line-strong bg-bg pl-6 pr-5 text-xs text-text outline-none placeholder:text-text-3 focus:border-accent"
            />
            {filter.query && (
              <button
                type="button"
                aria-label="검색 지우기"
                className="absolute right-1 grid size-4 place-items-center rounded-s text-text-3 hover:text-text"
                onClick={() => filter.onQuery("")}
              >
                <CloseIcon size={11} />
              </button>
            )}
          </label>
          <button
            type="button"
            aria-pressed={filter.onlyRising}
            onClick={filter.onToggleRising}
            className={`h-[var(--ctl-xs)] flex-none rounded-s px-2 text-xs font-[500] ${
              filter.onlyRising
                ? "bg-up-soft text-up shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--up)_35%,transparent)]"
                : "border border-line bg-bg text-text-2 hover:bg-hover hover:text-text"
            }`}
          >
            상승
          </button>
          {hasBothMicro && (
            <button
              type="button"
              aria-pressed={filter.onlyBothBuy}
              onClick={filter.onToggleBothBuy}
              className={`h-[var(--ctl-xs)] flex-none rounded-s px-2 text-xs font-[500] ${
                filter.onlyBothBuy
                  ? "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent)]"
                  : "border border-line bg-bg text-text-2 hover:bg-hover hover:text-text"
              }`}
            >
              양매수
            </button>
          )}
        </div>
      )}
      {rerun && (
        <p className="mx-3 mb-2 flex flex-none items-center gap-2 rounded-s bg-accent-soft px-2 py-1.5 text-xs text-accent">
          {rerun.kind === "new_day" ? `${dayLabel(rerun.day, result.asOf)} 자료가 들어왔습니다` : "저장소 자료가 바뀌었습니다"}
          <span className="flex-1" />
          <button type="button" className="font-[600] underline underline-offset-2" disabled={running} onClick={onRun}>
            새 자료로 다시 실행
          </button>
        </p>
      )}
      {rows.length === 0 ? (
        <StatePanel
          title="결과 없음"
          action={<button type="button" className="btn btn-sm" onClick={onEdit}><PenIcon size={14} />조건식 고치기</button>}
        >
          {result.missingSummary > 0
            ? `확인한 자료에서는 조건을 모두 만족하는 종목이 없습니다. 자료 누락 ${count(result.missingSummary)}종목은 판정할 수 없습니다.`
            : `대상 ${count(result.universe)}종목 가운데 조건을 모두 만족하는 종목이 없습니다.`}
          {left > 0 && ` 상장 기간이나 이력이 짧아 ${count(left)}종목이 빠졌습니다.`}
        </StatePanel>
      ) : filteredRows.length === 0 ? (
        <StatePanel
          title="필터 조건에 맞는 종목이 없습니다"
          action={<button type="button" className="btn btn-sm" onClick={filter.onReset}>필터 초기화</button>}
        >
          검색어나 필터를 풀면 결과를 다시 볼 수 있습니다.
        </StatePanel>
      ) : (
        <ResultTable screen={screen} asOf={result.asOf} rows={filteredRows} selected={selected} sort={sort} onSort={useScreenerStore.getState().setSort} onSelect={onSelect} onOpenInCell={onOpenInCell} />
      )}
    </section>
  );
}

const PHASE_NOTE: Record<UpdatePhase, string> = {
  symbols: "종목 목록과 종목 상태를 새로 받습니다.",
  recent: "받는 동안에도 차트는 그대로 쓸 수 있습니다.",
  backfill: "지금도 실행할 수 있고, 아직 덜 찬 과거는 이력 부족으로 빠집니다.",
};

const progressPercent = ({ done, total }: ScreenerUpdate) => (total > 0 ? Math.floor((done * 100) / total) : 0);
const progressText = (update: ScreenerUpdate) =>
  update.phase === "symbols" ? `${progressPercent(update)}%` : `${count(update.done)}/${count(update.total)}종목`;
const progressLabel = (update: ScreenerUpdate) =>
  update.phase === "symbols" ? progressText(update) : `${progressPercent(update)}% · ${progressText(update)}`;

const todayNote = (status: ScreenerStatus) => (todayConfirmed(status) ? "오늘 자료까지 받습니다." : "당일 봉은 20:00 뒤에 받습니다.");

function useUpdateRetry(error: ApiErrorBody | null): UpdateRetry | null {
  const origin = useServerClock((s) => s.serverTimeOrigin);
  const [wakes, wake] = useReducer((n: number) => n + 1, 0);
  const retry = error && updateRetry(error, serverNow(origin));
  const opensAt = retry?.kind === "waiting" ? retry.opensAt : null;
  useEffect(() => {
    if (opensAt === null) return;
    const id = setTimeout(wake, opensAt * 1000 - serverNow(origin));
    return () => clearTimeout(id);
  }, [opensAt, origin, wakes]);
  return retry;
}

function UpdateBand({ status }: { status: ScreenerStatus }) {
  const { start, cancel } = useUpdateCommands();
  const offline = useFeedBeforeConnect() !== null;
  const needsKiwoom = useScreenerRefreshNeedsKiwoom();
  const refreshTitle = needsKiwoom ? SCREENER_REFRESH_TOOLTIP : undefined;
  const waitLabel = (label: string) => (offline ? "연결 뒤" : label);
  const run = (full: boolean) => void start(full).catch(showCommandError);
  const update = status.update;
  const retry = useUpdateRetry(update?.error ?? null);
  const reference = status.needDay ?? status.lastDay;
  const stored = status.lastDay && reference ? `${dayLabel(status.lastDay, reference)}까지 있습니다.` : "받은 자료가 없습니다.";
  const frame = "flex-none border-b border-line bg-surface px-3 py-2.5";
  const kind = updateBandKind(status);

  if (kind === "running" && update) {
    const percent = progressPercent(update);
    return (
      <section aria-label="업데이트" role="status" className={frame}>
        <div className="flex items-center gap-2">
          <span className="text-accent">
            <SpinnerIcon />
          </span>
          <span className="min-w-0 truncate text-s font-[600]">
            {update.full && "전체 다시 받기 · "}
            {PHASE_LABEL[update.phase]}
          </span>
          <span className="flex-none text-s tabular-nums text-text-2">{progressLabel(update)}</span>
          <span className="flex-1" />
          <button type="button" className="btn btn-sm flex-none" onClick={() => void cancel().catch(showCommandError)}>
            취소
          </button>
        </div>
        <div
          role="progressbar"
          aria-label={`${PHASE_LABEL[update.phase]} 진행률`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised"
        >
          <span className="block h-full origin-left bg-accent" style={{ transform: `scaleX(${percent / 100})` }} />
        </div>
        <p className="mt-1.5 text-xs leading-[1.45] text-text-2">
          {stored} {PHASE_NOTE[update.phase]} {todayNote(status)}
        </p>
      </section>
    );
  }

  if (kind === "stopped" && update?.error && retry) {
    return (
      <section aria-label="업데이트" role="alert" className={frame}>
        <div className="flex items-center gap-2">
          <span className="conn-dot" data-tone="red" />
          <span className="text-s font-[600]">업데이트가 멈췄습니다</span>
          <span className="flex-1" />
          {retry.kind !== "operator" && (
            <button
              type="button"
              className="btn-primary btn-sm flex-none"
              disabled={retry.kind === "waiting" || offline || needsKiwoom}
              title={refreshTitle}
              onClick={() => run(update.full)}
            >
              {waitLabel(RETRY)}
              {!offline && retry.kind === "waiting" && <span className="font-[400]">· {retry.from}</span>}
            </button>
          )}
        </div>
        <p className="mt-1.5 text-xs leading-[1.45] text-danger">
          {PHASE_LABEL[update.phase]} {progressText(update)}에서 멈춤: {update.error.message}
        </p>
        <p className="mt-0.5 text-xs leading-[1.45] text-text-2">
          {stored}
          {retry.kind === "ready" && ` ${retry.note}`}
        </p>
      </section>
    );
  }

  if (kind === "empty") {
    return (
      <section aria-label="업데이트" className={frame}>
        <div className="flex items-center gap-2">
          <span className="conn-dot" data-tone="amber" />
          <span className="text-s font-[600]">아직 받은 KRX 일봉이 없습니다</span>
          <span className="flex-1" />
          <button type="button" className="btn-primary btn-sm flex-none" disabled={offline || needsKiwoom} title={refreshTitle} aria-label={offline ? "처음 받기 (연결 뒤에 쓸 수 있습니다)" : undefined} onClick={() => run(false)}>
            {waitLabel("처음 받기")}
          </button>
        </div>
        <p className="mt-1.5 text-xs leading-[1.45] text-text-2">
          스크리너는 서버에 모아 둔 KRX 일봉으로 찾습니다. 처음에는 종목마다 최근 600관측일을 먼저 받아 짧은 조건부터 쓸 수 있고, 전체 과거는 그 뒤에 이어 받습니다.
        </p>
      </section>
    );
  }

  if (kind === "missing_day" && status.needDay !== null) {
    return (
      <section aria-label="업데이트" className={frame}>
        <div className="flex items-center gap-2">
          <span className="conn-dot" data-tone="amber" />
          <span className="text-s font-[600]">자료가 모자랍니다</span>
          <span className="flex-1" />
          <button type="button" className="btn-primary btn-sm flex-none" disabled={offline || needsKiwoom} title={refreshTitle} aria-label={offline ? "업데이트 (연결 뒤에 쓸 수 있습니다)" : undefined} onClick={() => run(false)}>
            {waitLabel("업데이트")}
          </button>
        </div>
        <p className="mt-1.5 text-xs leading-[1.45] text-text-2">
          {stored} 실행하려면 {dayLabel(status.needDay, status.needDay)} 자료가 있어야 합니다. {todayNote(status)}
        </p>
      </section>
    );
  }

  return null;
}

function StatusFooterLine({ footer, status, onRetry }: { footer: StatusFooter; status: ScreenerStatus | undefined; onRetry(): void }) {
  if (footer.kind === "none") return null;
  if (footer.kind === "store" && status) return <StoreLine status={status} lastDay={footer.lastDay} />;
  const failed = footer.kind === "unreadable";
  return (
    <footer role={failed ? "alert" : undefined} className="flex flex-none items-center gap-2 border-t border-line px-3 py-2">
      <span className={`min-w-0 flex-1 truncate text-xs ${failed ? "text-danger" : "text-text-3"}`} title={failed ? footer.message : undefined}>
        {failed ? `저장소 상태를 ${footer.stale ? "다시 " : ""}읽지 못했습니다: ${footer.message}` : "저장소 상태를 읽는 중"}
      </span>
      {failed && <RetryButton onClick={onRetry} />}
    </footer>
  );
}

function StoreLine({ status, lastDay }: { status: ScreenerStatus; lastDay: KstDate }) {
  const { start } = useUpdateCommands();
  const offline = useFeedBeforeConnect() !== null;
  const needsKiwoom = useScreenerRefreshNeedsKiwoom();
  const today = status.todayAvailable;
  const history = status.fullHistory.done < status.fullHistory.total ? `과거 이력 ${count(status.fullHistory.done)}/${count(status.fullHistory.total)}종목` : null;
  const unconfirmed = status.unconfirmed > 0 ? `확인 안 됨 ${count(status.unconfirmed)}종목` : null;
  const notes = [today ? "오늘 자료를 받을 수 있습니다" : todayConfirmed(status) ? "빠진 관측일 없음" : "당일 봉은 20:00 뒤에 받습니다", history, unconfirmed].filter((n) => n !== null);
  return (
    <footer aria-label="KRX 일봉 저장소" className="flex flex-none items-center gap-2 border-t border-line px-3 py-2">
      <span className="conn-dot" data-tone={today ? "amber" : "mint"} />
      <span className="min-w-0 flex-1">
        <span className="block text-s font-[600]">KRX 일봉 · {dayLabel(lastDay, status.needDay ?? lastDay)}까지</span>
        <span className={`block truncate text-xs ${today ? "text-accent" : "text-text-3"}`}>{notes.join(" · ")}</span>
      </span>
      <button
        type="button"
        className={`btn btn-sm flex-none ${today ? "border-accent text-accent" : ""}`}
        disabled={offline || needsKiwoom}
        title={needsKiwoom ? SCREENER_REFRESH_TOOLTIP : undefined}
        aria-label={offline ? "업데이트 (연결 뒤에 쓸 수 있습니다)" : undefined}
        onClick={() => void start(false).catch(showCommandError)}
      >
        {offline ? "연결 뒤" : "업데이트"}
      </button>
    </footer>
  );
}
