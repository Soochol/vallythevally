import { FinancialUpdateButton } from "../financial-update/FinancialUpdateButton";
import { SentenceEditor } from "./SentenceEditor";
import { useScreenEditing } from "./useScreenEditing";
import { CHANGED, ChangedBadge } from "./ChangedBadge";
import { type ChosenScreen, FIX_INVALID, type ScreenEditing, type ScreenEntry } from "./screenEditing";
import { confirmAction } from "../overlay/Confirm";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { isTypingTarget } from "../../lib/hotkeys";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import {
  conditionSentence,
  dayLabel,
  EXCLUDE_LABEL,
  excludedInOrder,
  excludedText,
  isUpdating,
  MARKET_LABEL,
  marketsInOrder,
  NO_CONDITIONS_SENTENCE,
  PHASE_LABEL,
  type RunBlock,
  runBlock,
  showsUpdateBand,
  sortRows,
  type StatusFooter,
  statusFooter,
  todayConfirmed,
  type UpdateRetry,
  updateRetry,
} from "../../lib/screener";
import { listNameFrom, MAX_WATCHLISTS } from "../../lib/watchlist";
import { useCell } from "../../stores/layout";
import { type Rerun, rerunReason, type ScreenRun, shownResult, useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useWatchlistStore } from "../../stores/watchlist";
import { ChevronIcon, MoreIcon, PenIcon, PlayIcon, PlusIcon, SpinnerIcon, StarIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { ownsChartKeyboard } from "../overlay/topLayer";
import { EmptyState } from "../overlay/State";
import { ResultTable } from "./ResultTable";
import { ResultPreview } from "./ResultPreview";
import { compareResult, dropPendingOpen, openResult, pendingResultCode, sendToNewWatchlist, sendToWatchlist } from "./resultActions";
import { nextResult, previewRow, resultKeyAction } from "./results";

const PANEL_POLL_MS = 1_000;
const RAIL_POLL_MS = 10_000;
const BADGE_MAX = 999;
const FULL_RELOAD_CONFIRM =
  "모든 종목의 전체 이력을 처음부터 다시 받습니다. 2시간 가까이 걸릴 수 있고, 최근 관측일을 채우는 동안에는 실행할 수 없습니다. 받는 동안에도 차트는 그대로 쓸 수 있습니다.";

const toast = (text: string) => useSelectionStore.getState().showToast(text);
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const showCommandError = (e: unknown) => toast(`업데이트 명령을 보내지 못했습니다: ${reasonOf(e)}`);
const openDialog = () => useSelectionStore.getState().openScreenEditor();
const createInDialog = (screenEditing: ScreenEditing) => {
  screenEditing.create();
  openDialog();
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

function useActiveSymbol(): SymbolCode {
  return useCell(useSelectionStore((s) => s.activeSlot)).symbol;
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

export function ScreenerBadge() {
  const updating = isUpdating(useStoreStatus(RAIL_POLL_MS).data);
  const shown = shownResult(useScreenEditing().view.chosen?.run ?? null)?.rows.length;
  if (updating) {
    return (
      <span className="absolute right-0.5 top-0.5 text-accent">
        <SpinnerIcon size={10} />
        <span className="sr-only">업데이트 중</span>
      </span>
    );
  }
  if (shown === undefined) return null;
  return (
    <span className="absolute -right-0.5 top-0 min-w-[16px] rounded-full bg-raised px-1 text-center text-xs font-[650] leading-[15px] text-text">
      <span className="sr-only">결과 </span>
      {shown > BADGE_MAX ? `${BADGE_MAX}+` : shown}
      <span className="sr-only">종목</span>
    </span>
  );
}

export function PhoneScreener() {
  const shown = useSelectionStore((s) => s.phoneTab === "screener");
  const desktop = useMediaQuery(DESKTOP_QUERY);
  if (!shown || desktop) return null;
  return (
    <div className="fixed inset-x-0 bottom-[56px] top-0 z-30 flex flex-col bg-bg">
      <ScreenerPanel />
    </div>
  );
}

export function ScreenerPanel({ wide = false, onReturn = () => {} }: { wide?: boolean; onReturn?: () => void }) {
  const { editing: screenEditing, view, query: screens } = useScreenEditing();
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
  const queryClient = useQueryClient();
  const active = useActiveSymbol();
  const [preview, setPreview] = useState<{ screenId: string; code: SymbolCode } | null>(null);
  const [editing, setEditing] = useState(false);
  const selected = previewRow(rows, preview?.screenId === screen?.id ? preview?.code ?? null : null, active);
  const select = (code: SymbolCode) => {
    if (wide && screen) setPreview({ screenId: screen.id, code });
    else void openResult(queryClient, code);
  };
  const openPreview = (code = selected?.symbol) => {
    if (!code) return;
    void openResult(queryClient, code);
    onReturn();
  };
  const execute = () => {
    void screenEditing.run().then((outcome) => {
      if (outcome.kind === "invalid" && desktop) setEditing(true);
      else if (outcome.kind === "invalid") toast(FIX_INVALID);
      else if (outcome.kind === "failed") toast(outcome.message);
    });
  };
  const createInPanel = () => {
    screenEditing.create();
    useSelectionStore.getState().showRightPanel("screener");
    setEditing(true);
  };
  const createScreen = desktop ? createInPanel : () => createInDialog(screenEditing);
  useResultKeys({ rows, active: wide ? selected?.symbol ?? null : active, wide, onSelect: select, onOpen: openPreview, onRun: execute });
  useEffect(() => dropPendingOpen, []);
  useEffect(() => { if (wide) dropPendingOpen(); }, [wide]);
  const band = status !== undefined && showsUpdateBand(status);
  return (
    <aside aria-label="스크리너" data-chart-control className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={wide ? "grid min-h-0 flex-1 grid-cols-[160px_minmax(0,1fr)_240px] min-[1280px]:grid-cols-[200px_minmax(0,1fr)_300px]" : "flex min-h-0 flex-1 flex-col"}>
        {wide && <ScreenList screenEditing={screenEditing} entries={view.entries} loaded={screens.data !== undefined} chosen={screen?.id ?? null} onCreate={createScreen} />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="max-h-[50%] flex-none overflow-y-auto">
            {band && <UpdateBand status={status} />}
            {chosen && desktop ? (
              <SentenceEditor screenEditing={screenEditing} chosen={chosen} entries={view.entries} blocked={!status || block !== null} resultActions={<PanelMenu screen={screen} rows={rows} status={status} />} wide={wide} editing={editing} onEditingChange={setEditing} onRun={execute} />
            ) : chosen ? (
              <ScreenHeader screenEditing={screenEditing} chosen={chosen} entries={view.entries} block={block} status={status} rows={rows} onRun={execute} />
            ) : (
              <header className="flex h-11 flex-none items-center gap-1 border-b border-line pl-3 pr-1.5">
                <h2 className="text-l font-[700]">스크리너</h2>
                <span className="flex-1" />
                <FinancialUpdateButton className="md:hidden" />
                <PanelMenu screen={null} rows={rows} status={status} />
              </header>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {screen ? (
              <Results screen={screen} run={run} rows={rows} status={status} block={block} onRun={execute} onEdit={desktop ? () => setEditing(true) : openDialog} selected={wide ? selected?.symbol ?? null : active} onSelect={select} />
            ) : (
              <NoScreen query={screens} onCreate={createScreen} />
            )}
          </div>
        </div>
        {wide && (selected ? <ResultPreview row={selected} onOpen={openPreview} onCompare={() => compareResult(selected.symbol, selected.name)} /> : <aside className="border-l border-line"><EmptyState title="결과 종목을 골라 보세요">실행한 뒤 결과를 고르면 일봉을 미리 봅니다.</EmptyState></aside>)}
      </div>
      <StatusFooterLine footer={statusFooter(status, statusQuery.error)} status={status} onRetry={() => void statusQuery.refetch()} />
    </aside>
  );
}

interface ResultKeys {
  rows: readonly ScreenerRow[];
  active: SymbolCode | null;
  wide: boolean;
  onSelect(code: SymbolCode): void;
  onOpen(code?: SymbolCode): void;
  onRun(): void;
}

export type ScreenerKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented" | "target" | "preventDefault">;

export function handleResultKey(event: ScreenerKeyEvent, { rows, active, wide, onSelect, onOpen, onRun }: ResultKeys) {
  if (useSelectionStore.getState().dialog || ownsChartKeyboard(event) || isTypingTarget(event.target)) return;
  const action = resultKeyAction(event, wide);
  if (!action) return;
  if (action.kind !== "run" && event.target instanceof Element && event.target.closest("[data-screen-list]")) return;
  if (action.kind === "run") {
    event.preventDefault();
    onRun();
  } else if (action.kind === "move") {
    const code = nextResult(rows, wide ? active : pendingResultCode() ?? active, action.step);
    if (rows.length) event.preventDefault();
    if (code) onSelect(code);
  } else if (!(event.target instanceof Element) || !event.target.closest("button, a, summary, [role=button]")) {
    event.preventDefault();
    onOpen();
  } else if (event.target.closest("[data-result-row]")) {
    event.preventDefault();
    onOpen(event.target.closest<HTMLTableRowElement>("tr")?.dataset.code);
  }
}

function useResultKeys({ rows, active, wide, onSelect, onOpen, onRun }: ResultKeys) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => handleResultKey(event, { rows, active, wide, onSelect, onOpen, onRun });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, active, wide, onSelect, onOpen, onRun]);
}

function ScreenList({ screenEditing, entries, loaded, chosen, onCreate }: { screenEditing: ScreenEditing; entries: readonly ScreenEntry[]; loaded: boolean; chosen: string | null; onCreate(): void }) {
  return <nav aria-label="저장한 조건식" data-screen-list className="flex min-h-0 flex-col border-r border-line bg-surface">
    <div className="flex flex-none items-center justify-between border-b border-line p-2"><h2 className="text-s font-semibold">조건식</h2><button type="button" className="icon-btn" aria-label="새 조건식" disabled={!loaded} onClick={onCreate}><PlusIcon /></button></div>
    <div className="min-h-0 flex-1 overflow-y-auto p-1">{entries.map(({ source: screen, name, conditions }) => <button key={screen.id} type="button" aria-current={screen.id === chosen || undefined}
      className={`mb-1 w-full rounded-m p-2 text-left text-s ${screen.id === chosen ? "bg-accent-soft text-accent" : "hover:bg-raised"}`} onClick={() => { dropPendingOpen(); screenEditing.choose(screen.id); }}>
      <b className="block break-words font-semibold">{name || screen.name}</b><small className="text-xs text-text-3">조건 {conditions}개</small>
    </button>)}</div>
  </nav>;
}

interface HeaderProps {
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

function ScreenHeader({ screenEditing, chosen, entries, block, status, rows, onRun }: HeaderProps) {
  const { screen } = chosen;
  const running = chosen.run?.kind === "running";
  return (
    <header className="flex-none border-b border-line px-3 pb-3 pt-2">
      <div className="flex items-center gap-1">
        <FinancialUpdateButton className="md:hidden" />
        <ScreenPicker screenEditing={screenEditing} entries={entries} chosen={chosen} />
        {chosen.dirty && <ChangedBadge />}
        <span className="flex-1" />
        <button type="button" className="tb-btn h-7 gap-1 px-2 text-s text-text-2" title="조건식 편집" onClick={openDialog}>
          <PenIcon size={14} />
          편집
        </button>
        <button type="button" className="icon-btn" title="새 조건식" aria-label="새 조건식" onClick={() => createInDialog(screenEditing)}>
          <PlusIcon />
        </button>
        <PanelMenu screen={screen} rows={rows} status={status} />
      </div>
      <ScreenSummary screen={screen} />
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
          {running ? "실행 중" : "실행"}<kbd className="ml-1 text-xs">Ctrl+↵</kbd>
        </button>
        <span className="min-w-0 text-xs leading-[1.4] text-text-2">{runHint(block, status)}</span>
      </div>
    </header>
  );
}

function ScreenPicker({ screenEditing, entries, chosen }: { screenEditing: ScreenEditing; entries: readonly ScreenEntry[]; chosen: ChosenScreen }) {
  const menu = useMenuToggle();
  const name = chosen.title;
  const items: MenuItem[] = [
    ...entries.map((entry): MenuItem => ({ kind: "radio", label: entry.title, hint: entry.dirty ? CHANGED : undefined, checked: entry.source.id === chosen.source.id, onSelect: () => { dropPendingOpen(); screenEditing.choose(entry.source.id); } })),
    { kind: "separator" },
    { kind: "action", label: "새 조건식…", onSelect: () => createInDialog(screenEditing) },
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
        <span className="truncate text-l font-[700]">{name}</span>
        <ChevronIcon />
      </button>
      {menu.open && (
        <Menu label="조건식 고르기" items={items} onClose={menu.close} root={menu.root} className="absolute left-0 top-[calc(100%+4px)] max-h-[60vh] min-w-[240px] overflow-auto" />
      )}
    </div>
  );
}

function ScreenSummary({ screen }: { screen: Screen }) {
  const markets = marketsInOrder(screen.markets);
  const excluded = excludedInOrder(screen.exclude);
  return (
    <div className="mt-1.5 rounded-m border border-line bg-surface px-2.5 py-2">
      <p className="flex flex-wrap items-center gap-1 text-xs text-text-3">
        {markets.length === 0 && excluded.length === 0 && <span>전 종목 대상</span>}
        {markets.length > 0 && (
          <>
            <span>대상</span>
            {markets.map((m) => (
              <span key={m} className="rounded-s bg-raised px-1.5 py-px font-[600] text-text-2">
                {MARKET_LABEL[m]}
              </span>
            ))}
          </>
        )}
        {markets.length > 0 && excluded.length > 0 && <span aria-hidden="true">·</span>}
        {excluded.length > 0 && (
          <>
            <span>제외</span>
            {excluded.map((k) => (
              <span key={k} className="rounded-s border border-line px-1 py-px text-text-2">
                {EXCLUDE_LABEL[k]}
              </span>
            ))}
          </>
        )}
      </p>
      {screen.conditions.length === 0 ? (
        <p className="mt-1.5 text-s leading-[1.5]">{NO_CONDITIONS_SENTENCE}</p>
      ) : (
        <ol aria-label="조건" className="mt-1.5 text-s leading-[1.5]">
          {screen.conditions.map((c, i) => (
            <li key={i}>
              {i > 0 && <span className="mr-1 text-xs font-[600] text-accent">그리고</span>}
              {conditionSentence(c)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PanelMenu({ screen, rows, status, saveOnly = false }: { screen: Screen | null; rows: readonly ScreenerRow[]; status: ScreenerStatus | undefined; saveOnly?: boolean }) {
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
  const reload = async () => {
    if (await confirmAction(FULL_RELOAD_CONFIRM)) void start(true).catch(showCommandError);
  };
  const items: MenuItem[] = [
    { kind: "heading", label: nothing ? "관심종목으로 보내기" : `결과 ${count(codes.length)}종목을 관심종목으로 보내기` },
    ...lists.map((l): MenuItem => ({ kind: "action", label: l.name, disabled: nothing, onSelect: () => sendToWatchlist(l.id, codes) })),
    ...newList,
    ...(!saveOnly ? [
      { kind: "separator" } satisfies MenuItem,
      { kind: "action", label: "전체 다시 받기…", hint: waiting?.from, disabled: isUpdating(status) || waiting !== null, onSelect: reload } satisfies MenuItem,
    ] : []),
  ];
  return (
    <div ref={menu.root} className="relative">
      <button
        ref={menu.button}
        type="button"
        className={saveOnly ? "tb-btn h-[var(--size-26)] gap-1 whitespace-nowrap text-xs" : "icon-btn"}
        title={saveOnly ? "결과를 관심종목으로 저장" : "관심종목으로 보내기, 전체 다시 받기"}
        aria-label={saveOnly ? "결과를 관심종목으로 저장" : "스크리너 메뉴"}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        {saveOnly ? <><StarIcon size={12} />관심종목으로</> : <MoreIcon />}
      </button>
      {menu.open && (
        <Menu label="스크리너 메뉴" items={items} onClose={menu.close} root={menu.root} className="absolute right-0 top-[calc(100%+4px)] max-h-[60vh] min-w-[220px] overflow-auto" />
      )}
    </div>
  );
}

function Notice({ title, children, action, tone = "plain" }: { title: string; children?: ReactNode; action?: ReactNode; tone?: "plain" | "alert" }) {
  return (
    <div role={tone === "alert" ? "alert" : undefined} className="flex min-h-0 flex-1 flex-col items-start gap-2 px-6 pt-10">
      <p className="text-m font-[650]">{title}</p>
      {children && <p className={`text-s leading-[1.5] ${tone === "alert" ? "text-danger" : "text-text-2"}`}>{children}</p>}
      {action}
    </div>
  );
}

function NoScreen({ query, onCreate }: { query: UseQueryResult<Screens>; onCreate(): void }) {
  if (query.isPending) return <Notice title="조건식을 불러오는 중입니다" />;
  if (query.isError) {
    return (
      <Notice title="조건식을 불러오지 못했습니다" tone="alert" action={<RetryButton onClick={() => void query.refetch()} />}>
        {query.error.message}
      </Notice>
    );
  }
  return (
    <Notice
      title="저장한 조건식이 없습니다"
      action={
        <button type="button" className="btn-primary mt-1 flex h-8 items-center gap-1.5 px-3 text-s" onClick={onCreate}>
          <PlusIcon size={14} />새 조건식
        </button>
      }
    >
      조건식에 이름과 조건을 정해 저장하면 여기서 골라 실행합니다.
    </Notice>
  );
}

function RetryButton({ onClick, label = "다시 시도", disabled = false }: { onClick(): void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" className="tb-btn h-8 border border-line text-s disabled:opacity-40" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

const NOT_RUN: Record<RunBlock | "ready", { title: string; body: string }> = {
  ready: { title: "실행하면 결과가 여기에 나옵니다", body: "행을 누르거나 ↑↓로 결과를 차례로 칸에 엽니다." },
  updating: { title: "최근 관측일을 채우고 있습니다", body: "끝나면 실행할 수 있습니다." },
  missing_day: { title: "새 자료가 필요합니다", body: "위에서 업데이트하면 빠진 관측일을 채웁니다." },
  empty: { title: "저장소가 비어 있습니다", body: "위에서 처음 받기를 누르면 KRX 일봉을 받습니다." },
};

interface ResultsProps {
  screen: Screen;
  run: ScreenRun | null;
  rows: readonly ScreenerRow[];
  status: ScreenerStatus | undefined;
  block: RunBlock | null;
  onRun(): void;
  onEdit(): void;
  selected: SymbolCode | null;
  onSelect(code: SymbolCode): void;
}

function Results({ screen, run, rows, status, block, onRun, onEdit, selected, onSelect }: ResultsProps) {
  const result = shownResult(run);
  const storeVersion = useScreenerStore((s) => s.storeVersion);
  const rerun = block === null ? rerunReason(run, storeVersion, status) : null;
  const failure = run?.kind === "failed" ? run : null;
  const message = failure?.error.reason === "data_changed"
    ? `수집 중 자료가 바뀌었습니다. ${failure.error.message}`
    : failure?.error.message;
  if (result) return (
    <>
      {failure && <p role="alert" className="flex-none border-b border-line px-3 py-2 text-s text-danger">실행하지 못했습니다. {message} 이전 결과와 수집 시각을 유지합니다.</p>}
      <ResultList screen={screen} result={result} rows={rows} running={run?.kind === "running"} rerun={rerun} onRun={onRun} onEdit={onEdit} selected={selected} onSelect={onSelect} />
    </>
  );
  if (failure) return (
    <Notice title="실행하지 못했습니다" tone="alert" action={<RetryButton label="다시 실행" disabled={block !== null} onClick={onRun} />}>
      결과 없음. {message}
    </Notice>
  );
  if (run?.kind === "running") return <Notice title="찾는 중입니다" />;
  const { title, body } = NOT_RUN[block ?? "ready"];
  return <Notice title={title}>{body}</Notice>;
}

interface ResultListProps extends Omit<ResultsProps, "run" | "status" | "block"> {
  result: ScreenerResult;
  running: boolean;
  rerun: Rerun | null;
}

const collectionTime = (seconds: number) => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).format(new Date(seconds * 1000));

function ResultList({ screen, result, rows, running, rerun, onRun, onEdit, selected, onSelect }: ResultListProps) {
  const sort = useScreenerStore((s) => s.sort);
  const left = result.excluded.listedTooShort + result.excluded.historyShort;
  return (
    <section aria-label="결과" aria-busy={running} className={`flex flex-col ${running ? "opacity-50" : ""}`}>
      <div className="flex flex-none items-baseline gap-1.5 px-3 pt-2.5">
        <span className="text-xl font-[700] leading-none">{count(rows.length)}</span>
        <span className="min-w-0 flex-1 text-s text-text-2">종목 · {dayLabel(result.asOf, result.asOf)} 기준</span>
        <PanelMenu screen={screen} rows={rows} status={undefined} saveOnly />
      </div>
      <details className="px-3 py-1 text-xs text-text-3"><summary className="cursor-pointer">결과 자료 · 수집 시각과 제외 내역</summary>
      <div aria-label="결과 자료" className="flex-none space-y-1 px-3 pt-1 text-xs leading-relaxed text-text-2">
        <p>기준 관측일 {result.asOf} · KRX</p>
        <p>수집 범위 (KST) <time>{collectionTime(result.collectionStartedAt)}</time> ~ <time>{collectionTime(result.collectionCompletedAt)}</time></p>
        <p>종가는 일봉 0봉 가격 · 등락률은 직전 거래 일봉 대비</p>
        <p>{screen.conditions.some((condition) => "period" in condition) ? "충족일은 첫 봉 조건의 최근 일치일 · 주·월봉은 시작일" : "충족일은 기준 관측일입니다"}</p>
        <p>잠정은 이번 수집의 당일 요약입니다</p>
        <p>자료 누락 {count(result.missingSummary)}종목{result.missingSummary > 0 && " · 자료를 확인하지 못해 판정에서 빠졌습니다"}</p>
      </div>
      <p className="flex-none px-3 pb-2 pt-1 text-xs text-text-3">
        대상 {count(result.universe)}종목 · 빠짐: {excludedText(result.excluded)}
      </p>
      </details>
      {rerun && (
        <p className="mx-3 mb-2 flex flex-none items-center gap-2 rounded-s bg-accent-soft px-2 py-1.5 text-xs text-accent">
          {rerun.kind === "new_day" ? `${dayLabel(rerun.day, result.asOf)} 자료가 들어왔습니다` : "저장소 자료가 바뀌었습니다"}
          <span className="flex-1" />
          <button type="button" className="font-[650] underline underline-offset-2" disabled={running} onClick={onRun}>
            새 자료로 다시 실행
          </button>
        </p>
      )}
      {rows.length === 0 ? (
        <div className="border-t border-line px-6 py-8">
          <p className="text-m font-[650]">결과 없음</p>
          <p className="mt-1.5 text-s leading-[1.5] text-text-2">
            {result.missingSummary > 0
              ? `확인한 자료에서는 조건을 모두 만족하는 종목이 없습니다. 자료 누락 ${count(result.missingSummary)}종목은 판정할 수 없습니다.`
              : `대상 ${count(result.universe)}종목 가운데 조건을 모두 만족하는 종목이 없습니다.`}
            {left > 0 && ` 상장 기간이나 이력이 짧아 ${count(left)}종목이 빠졌습니다.`}
          </p>
          <button type="button" className="tb-btn mt-3 h-8 border border-line text-s" onClick={onEdit}>
            <PenIcon size={14} />
            조건식 고치기
          </button>
        </div>
      ) : (
        <ResultTable screen={screen} asOf={result.asOf} rows={rows} selected={selected} sort={sort} onSort={useScreenerStore.getState().setSort} onSelect={onSelect} />
      )}
      <p className="px-3 py-2 text-xs text-text-3">↑↓ 결과 이동 · ↵ 칸에 열기</p>
    </section>
  );
}

const PHASE_NOTE: Record<UpdatePhase, string> = {
  symbols: "종목 목록과 종목 상태를 새로 받습니다.",
  recent: "받는 동안에도 차트는 그대로 쓸 수 있습니다.",
  backfill: "지금도 실행할 수 있고, 아직 덜 찬 과거는 이력 부족으로 빠집니다.",
};

const progressText = ({ phase, done, total }: ScreenerUpdate) =>
  phase === "symbols" ? `${total > 0 ? Math.floor((done * 100) / total) : 0}%` : `${count(done)}/${count(total)}종목`;

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
  const run = (full: boolean) => void start(full).catch(showCommandError);
  const update = status.update;
  const retry = useUpdateRetry(update?.error ?? null);
  const reference = status.needDay ?? status.lastDay;
  const stored = status.lastDay && reference ? `${dayLabel(status.lastDay, reference)}까지 있습니다.` : "받은 자료가 없습니다.";
  const frame = "flex-none border-b border-line bg-surface px-3 py-2.5";

  if (update && update.error === null) {
    const percent = update.total > 0 ? Math.floor((update.done * 100) / update.total) : 0;
    return (
      <section aria-label="업데이트" role="status" className={frame}>
        <div className="flex items-center gap-2">
          <span className="text-accent">
            <SpinnerIcon />
          </span>
          <span className="min-w-0 truncate text-s font-[650]">
            {update.full && "전체 다시 받기 · "}
            {PHASE_LABEL[update.phase]}
          </span>
          <span className="flex-none text-s text-text-2">{progressText(update)}</span>
          <span className="flex-1" />
          <button type="button" className="tb-btn h-7 flex-none border border-line px-2.5 text-s" onClick={() => void cancel().catch(showCommandError)}>
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
          <span className="block h-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-1.5 text-xs leading-[1.45] text-text-2">
          {stored} {PHASE_NOTE[update.phase]} {todayNote(status)}
        </p>
      </section>
    );
  }

  if (update?.error && retry) {
    return (
      <section aria-label="업데이트" role="alert" className={frame}>
        <div className="flex items-center gap-2">
          <span className="conn-dot" data-tone="red" />
          <span className="text-s font-[650]">업데이트가 멈췄습니다</span>
          <span className="flex-1" />
          {retry.kind !== "operator" && (
            <button
              type="button"
              className="btn-primary h-7 flex-none px-3 text-s disabled:cursor-not-allowed disabled:opacity-40"
              disabled={retry.kind === "waiting"}
              onClick={() => run(update.full)}
            >
              다시 시도
            </button>
          )}
        </div>
        <p className="mt-1.5 text-xs leading-[1.45] text-danger">
          {PHASE_LABEL[update.phase]} {progressText(update)}에서 멈춤: {update.error.message}
        </p>
        <p className="mt-0.5 text-xs leading-[1.45] text-text-2">
          {stored}
          {retry.kind !== "operator" && ` ${retry.note}`}
        </p>
      </section>
    );
  }

  const block = runBlock(status);
  if (block === "empty") {
    return (
      <section aria-label="업데이트" className={frame}>
        <div className="flex items-center gap-2">
          <span className="conn-dot" data-tone="red" />
          <span className="text-s font-[650]">아직 받은 KRX 일봉이 없습니다</span>
          <span className="flex-1" />
          <button type="button" className="btn-primary h-7 flex-none px-3 text-s" onClick={() => run(false)}>
            처음 받기
          </button>
        </div>
        <p className="mt-1.5 text-xs leading-[1.45] text-text-2">
          스크리너는 서버에 모아 둔 KRX 일봉으로 찾습니다. 처음에는 종목마다 최근 600관측일을 먼저 받아 짧은 조건부터 쓸 수 있고, 전체 과거는 그 뒤에 이어 받습니다.
        </p>
      </section>
    );
  }

  if (block === "missing_day" && status.needDay !== null) {
    return (
      <section aria-label="업데이트" className={frame}>
        <div className="flex items-center gap-2">
          <span className="conn-dot" data-tone="red" />
          <span className="text-s font-[650]">자료가 모자랍니다</span>
          <span className="flex-1" />
          <button type="button" className="btn-primary h-7 flex-none px-3 text-s" onClick={() => run(false)}>
            업데이트
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
        className={`tb-btn h-7 flex-none px-2.5 text-s font-[600] ${today ? "border border-accent text-accent" : "text-text-2"}`}
        onClick={() => void start(false).catch(showCommandError)}
      >
        업데이트
      </button>
    </footer>
  );
}
