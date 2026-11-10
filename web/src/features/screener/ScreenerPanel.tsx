import type { UseQueryResult } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KstDate } from "../../api/generated/KstDate";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import type { ScreenerStatus } from "../../api/generated/ScreenerStatus";
import type { ScreenerUpdate } from "../../api/generated/ScreenerUpdate";
import type { ScreenPeriod } from "../../api/generated/ScreenPeriod";
import type { Screens } from "../../api/generated/Screens";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UpdatePhase } from "../../api/generated/UpdatePhase";
import { useScreenerStatus, useScreens, useUpdateCommands } from "../../api/screener";
import { direction, formatPercent, formatPrice } from "../../lib/format";
import { isTypingTarget } from "../../lib/hotkeys";
import {
  conditionSentence,
  dayLabel,
  EXCLUDE_LABEL,
  excludedInOrder,
  excludedText,
  highDateText,
  isUpdating,
  nextSort,
  PERIOD_NAME,
  PHASE_LABEL,
  type ResultSort,
  type ResultSortKey,
  type RunBlock,
  runBlock,
  showsUpdateBand,
  sortRows,
  todayNotStored,
} from "../../lib/screener";
import { listNameFrom, MAX_WATCHLISTS } from "../../lib/watchlist";
import { useCell, useLayoutStore } from "../../stores/layout";
import { type Rerun, rerunReason, runOf, type ScreenRun, shownResult, useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { useWatchlistStore } from "../../stores/watchlist";
import { ChevronIcon, MoreIcon, PenIcon, PlayIcon, PlusIcon, SpinnerIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";

const PANEL_POLL_MS = 1_000;
const RAIL_POLL_MS = 10_000;
const BADGE_MAX = 999;
const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;
const ROW_GRID = { gridTemplateColumns: "minmax(0,1fr) 76px 64px 64px" };
const FULL_RELOAD_CONFIRM =
  "모든 종목의 전체 이력을 처음부터 다시 받습니다. 2시간 가까이 걸릴 수 있고, 최근 관측일을 채우는 동안에는 실행할 수 없습니다. 받는 동안에도 차트는 그대로 쓸 수 있습니다.";

const toast = (text: string) => useSelectionStore.getState().showToast(text);
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const showCommandError = (e: unknown) => toast(`업데이트 명령을 보내지 못했습니다: ${reasonOf(e)}`);
const openScreenEditor = () => toast("조건식 편집 화면은 아직 없습니다");
const count = (n: number) => n.toLocaleString("ko-KR");

function openResult(code: SymbolCode) {
  useLayoutStore.getState().setSymbol(useSelectionStore.getState().activeSlot, { code, nxtEnabled: false }, "krx");
}

function useChosenScreen() {
  const screens = useScreens();
  const chosenId = useScreenerStore((s) => s.chosenId);
  const list = screens.data?.screens;
  const screen = list?.find((s) => s.id === chosenId) ?? list?.[0] ?? null;
  const run = useScreenerStore((s) => (screen ? runOf(s.runs, screen) : null));
  return { screens, screen, run };
}

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
  const shown = shownResult(useChosenScreen().run)?.rows.length;
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
    <span className="absolute -right-0.5 top-0 min-w-[16px] rounded-full bg-raised px-1 text-center text-[10px] font-[650] leading-[15px] text-text">
      <span className="sr-only">결과 </span>
      {shown > BADGE_MAX ? `${BADGE_MAX}+` : shown}
      <span className="sr-only">종목</span>
    </span>
  );
}

export function ScreenerPanel() {
  const { screens, screen, run } = useChosenScreen();
  const statusQuery = useStoreStatus(PANEL_POLL_MS);
  const status = statusQuery.data;
  const block = status ? runBlock(status) : null;
  const sort = useScreenerStore((s) => s.sort);
  const result = shownResult(run);
  const rows = useMemo(() => (result ? sortRows(result.rows, sort) : []), [result, sort]);
  const { refresh } = useUpdateCommands();
  const execute = () => {
    if (screen) void useScreenerStore.getState().run(screen).then(refresh);
  };
  useResultKeys(rows);
  const band = status !== undefined && showsUpdateBand(status);
  return (
    <aside aria-label="스크리너" className="flex min-h-0 flex-1 flex-col">
      {band && <UpdateBand status={status} />}
      {screen ? (
        <ScreenHeader screen={screen} screens={screens.data?.screens ?? []} run={run} block={block} status={status} rows={rows} onRun={execute} />
      ) : (
        <header className="flex h-11 flex-none items-center gap-1 border-b border-line pl-3 pr-1.5">
          <h2 className="text-l font-[700]">스크리너</h2>
          <span className="flex-1" />
          <PanelMenu screen={null} rows={rows} status={status} />
        </header>
      )}
      {screen ? (
        <Results screen={screen} run={run} rows={rows} status={status} block={block} onRun={execute} />
      ) : (
        <NoScreen query={screens} />
      )}
      {status === undefined ? <StatusProblem query={statusQuery} /> : !band && status.lastDay !== null && <StoreLine status={status} lastDay={status.lastDay} />}
    </aside>
  );
}

function useResultKeys(rows: readonly ScreenerRow[]) {
  const active = useActiveSymbol();
  useEffect(() => {
    if (rows.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (useSelectionStore.getState().dialog || isTypingTarget(e.target)) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const at = rows.findIndex((r) => r.symbol === active);
      const next = at < 0 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step));
      if (next !== at) openResult(rows[next]!.symbol);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, active]);
}

function useFollowActive(list: RefObject<HTMLUListElement | null>, active: SymbolCode, rows: readonly ScreenerRow[]) {
  useEffect(() => {
    const root = list.current;
    const row = root?.querySelector<HTMLElement>(`[data-code="${CSS.escape(active)}"]`);
    if (!root || !row) return;
    row.scrollIntoView({ block: "nearest" });
    if (root.contains(document.activeElement)) row.querySelector<HTMLElement>("[data-main]")?.focus();
  }, [list, active, rows]);
}

interface HeaderProps {
  screen: Screen;
  screens: readonly Screen[];
  run: ScreenRun | null;
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
  if (block) return <span className="text-up">{BLOCK_HINT[block]}</span>;
  if (!status?.lastDay) return null;
  return (
    <>
      <b className="font-[600] text-text">{dayLabel(status.lastDay, status.needDay ?? status.lastDay)}</b> 장 마감 자료로 찾습니다
    </>
  );
}

function ScreenHeader({ screen, screens, run, block, status, rows, onRun }: HeaderProps) {
  const running = run?.kind === "running";
  return (
    <header className="flex-none border-b border-line px-3 pb-3 pt-2">
      <div className="flex items-center gap-1">
        <ScreenPicker screens={screens} screen={screen} />
        <span className="flex-1" />
        <button type="button" className="tb-btn h-7 gap-1 px-2 text-s text-text-2" title="조건식 편집" onClick={openScreenEditor}>
          <PenIcon size={14} />
          편집
        </button>
        <button type="button" className="icon-btn" title="새 조건식" aria-label="새 조건식" onClick={openScreenEditor}>
          <PlusIcon />
        </button>
        <PanelMenu screen={screen} rows={rows} status={status} />
      </div>
      <ScreenSummary screen={screen} />
      <div className="mt-2.5 flex items-center gap-2.5">
        <button
          type="button"
          className="btn-primary flex h-8 flex-none items-center gap-1.5 px-4 text-s disabled:cursor-not-allowed disabled:opacity-40"
          disabled={block !== null || running}
          onClick={onRun}
        >
          {running ? <SpinnerIcon /> : <PlayIcon />}
          {running ? "실행 중" : "실행"}
        </button>
        <span className="min-w-0 text-xs leading-[1.4] text-text-2">{runHint(block, status)}</span>
      </div>
    </header>
  );
}

function ScreenPicker({ screens, screen }: { screens: readonly Screen[]; screen: Screen }) {
  const menu = useMenuToggle();
  const choose = useScreenerStore((s) => s.choose);
  const items: MenuItem[] = [
    ...screens.map((s): MenuItem => ({ kind: "radio", label: `${s.name} · ${PERIOD_NAME[s.period]}`, checked: s.id === screen.id, onSelect: () => choose(s.id) })),
    { kind: "separator" },
    { kind: "action", label: "새 조건식…", onSelect: openScreenEditor },
  ];
  return (
    <div ref={menu.root} className="relative -ml-1.5 min-w-0">
      <button
        ref={menu.button}
        type="button"
        title="조건식 고르기"
        aria-label={`조건식: ${screen.name}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-m px-1.5 py-1 hover:bg-raised"
      >
        <span className="truncate text-l font-[700]">{screen.name}</span>
        <ChevronIcon />
      </button>
      {menu.open && (
        <Menu label="조건식 고르기" items={items} onClose={menu.close} root={menu.root} className="absolute left-0 top-[calc(100%+4px)] max-h-[60vh] min-w-[240px] overflow-auto" />
      )}
    </div>
  );
}

function ScreenSummary({ screen }: { screen: Screen }) {
  const excluded = excludedInOrder(screen.exclude);
  return (
    <div className="mt-1.5 rounded-m border border-line bg-surface px-2.5 py-2">
      <p className="flex flex-wrap items-center gap-1 text-xs text-text-3">
        <span className="rounded-s bg-raised px-1.5 py-px font-[600] text-text-2">{PERIOD_NAME[screen.period]}</span>
        {excluded.length === 0 ? (
          <span>전 종목 대상</span>
        ) : (
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
      <ol aria-label="조건" className="mt-1.5 text-s leading-[1.5]">
        {screen.conditions.map((c, i) => (
          <li key={i}>
            {i > 0 && <span className="mr-1 text-xs font-[600] text-accent">그리고</span>}
            {conditionSentence(screen.period, c)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function sendToWatchlist(listId: string, codes: readonly SymbolCode[]) {
  const store = useWatchlistStore.getState();
  const list = store.lists.find((l) => l.id === listId);
  if (!list) return;
  const fresh = codes.filter((c) => !list.symbols.includes(c));
  for (const code of fresh) store.add(listId, code);
  const skipped = codes.length - fresh.length;
  if (fresh.length === 0) return toast(`${list.name}에 이미 모두 있습니다`);
  toast(`${list.name}에 ${count(fresh.length)}종목을 넣었습니다${skipped > 0 ? ` (이미 있던 ${count(skipped)}종목은 건너뜀)` : ""}`);
}

function sendToNewWatchlist(name: string, codes: readonly SymbolCode[]) {
  const id = crypto.randomUUID();
  useWatchlistStore.getState().create(id, name);
  useUiStore.getState().setActiveWatchlist(id);
  sendToWatchlist(id, codes);
}

function PanelMenu({ screen, rows, status }: { screen: Screen | null; rows: readonly ScreenerRow[]; status: ScreenerStatus | undefined }) {
  const menu = useMenuToggle();
  const lists = useWatchlistStore((s) => s.lists);
  const { start } = useUpdateCommands();
  const codes = rows.map((r) => r.symbol);
  const nothing = codes.length === 0;
  const fresh = screen ? listNameFrom(lists, screen.name) : null;
  const newList: MenuItem[] =
    fresh === null
      ? []
      : [{ kind: "action", label: `새 목록 "${fresh}"`, disabled: nothing || lists.length >= MAX_WATCHLISTS, onSelect: () => sendToNewWatchlist(fresh, codes) }];
  const reload = () => {
    if (window.confirm(FULL_RELOAD_CONFIRM)) void start(true).catch(showCommandError);
  };
  const items: MenuItem[] = [
    { kind: "heading", label: nothing ? "관심종목으로 보내기" : `결과 ${count(codes.length)}종목을 관심종목으로 보내기` },
    ...lists.map((l): MenuItem => ({ kind: "action", label: l.name, disabled: nothing, onSelect: () => sendToWatchlist(l.id, codes) })),
    ...newList,
    { kind: "separator" },
    { kind: "action", label: "전체 다시 받기…", disabled: isUpdating(status), onSelect: reload },
  ];
  return (
    <div ref={menu.root} className="relative">
      <button
        ref={menu.button}
        type="button"
        className="icon-btn"
        title="관심종목으로 보내기, 전체 다시 받기"
        aria-label="스크리너 메뉴"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <MoreIcon />
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
      {children && <p className={`text-s leading-[1.5] ${tone === "alert" ? "text-up" : "text-text-2"}`}>{children}</p>}
      {action}
    </div>
  );
}

function NoScreen({ query }: { query: UseQueryResult<Screens> }) {
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
        <button type="button" className="btn-primary mt-1 flex h-8 items-center gap-1.5 px-3 text-s" onClick={openScreenEditor}>
          <PlusIcon size={14} />새 조건식
        </button>
      }
    >
      조건식에 이름, 봉 주기, 신고가 조건을 정해 저장하면 여기서 골라 실행합니다.
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
  ready: { title: "실행하면 결과가 여기에 나옵니다", body: "행을 누르거나 ↑↓로 결과를 차례로 칸에 엽니다. 칸의 거래소는 KRX로 바뀝니다." },
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
}

function Results({ screen, run, rows, status, block, onRun }: ResultsProps) {
  const result = shownResult(run);
  const storeVersion = useScreenerStore((s) => s.storeVersion);
  const rerun = block === null ? rerunReason(run, storeVersion, status) : null;
  if (run?.kind === "failed") {
    return (
      <Notice title="실행하지 못했습니다" tone="alert" action={<RetryButton label="다시 실행" disabled={block !== null} onClick={onRun} />}>
        {run.error.message}
      </Notice>
    );
  }
  if (result) return <ResultList screen={screen} result={result} rows={rows} running={run?.kind === "running"} rerun={rerun} onRun={onRun} />;
  if (run?.kind === "running") return <Notice title="찾는 중입니다" />;
  const { title, body } = NOT_RUN[block ?? "ready"];
  return <Notice title={title}>{body}</Notice>;
}

interface ResultListProps extends Omit<ResultsProps, "run" | "status" | "block"> {
  result: ScreenerResult;
  running: boolean;
  rerun: Rerun | null;
}

function ResultList({ screen, result, rows, running, rerun, onRun }: ResultListProps) {
  const active = useActiveSymbol();
  const list = useRef<HTMLUListElement>(null);
  useFollowActive(list, active, rows);
  const sort = useScreenerStore((s) => s.sort);
  const left = result.excluded.listedTooShort + result.excluded.historyShort;
  return (
    <section aria-label="결과" aria-busy={running} className={`flex min-h-0 flex-1 flex-col ${running ? "opacity-50" : ""}`}>
      <div className="flex flex-none items-baseline gap-1.5 px-3 pt-2.5">
        <span className="text-xl font-[700] leading-none">{count(rows.length)}</span>
        <span className="text-s text-text-2">종목 · {dayLabel(result.asOf, result.asOf)} 기준</span>
        <span className="flex-1" />
        <span className="text-xs text-text-3" title="스크리너는 KRX 일봉으로 찾으므로, 결과를 열면 칸의 거래소를 KRX로 바꿉니다">
          KRX로 엶
        </span>
      </div>
      <p className="flex-none px-3 pb-2 pt-1 text-xs text-text-3">
        대상 {count(result.universe)}종목 · 빠짐: {excludedText(screen, result.excluded)}
      </p>
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
            대상 {count(result.universe)}종목 가운데 조건을 모두 만족하는 종목이 없습니다.
            {left > 0 && ` 상장 기간이나 이력이 짧아 ${count(left)}종목이 빠졌습니다.`}
          </p>
          <button type="button" className="tb-btn mt-3 h-8 border border-line text-s" onClick={openScreenEditor}>
            <PenIcon size={14} />
            조건식 고치기
          </button>
        </div>
      ) : (
        <>
          <SortHeader sort={sort} />
          <ul ref={list} aria-label={`${screen.name} 결과`} className="min-h-0 flex-1 overflow-auto">
            {rows.map((r) => (
              <ResultRow key={r.symbol} row={r} period={screen.period} asOf={result.asOf} active={r.symbol === active} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const COLUMNS: readonly { key: ResultSortKey; label: string }[] = [
  { key: "name", label: "종목" },
  { key: "close", label: "종가" },
  { key: "changeRate", label: "등락률" },
  { key: "highDate", label: "신고가" },
];

function SortHeader({ sort }: { sort: ResultSort }) {
  const setSort = useScreenerStore((s) => s.setSort);
  return (
    <div style={ROW_GRID} className="grid flex-none items-center gap-1 border-y border-line px-3 py-1 text-xs text-text-3">
      {COLUMNS.map(({ key, label }) => {
        const on = sort.key === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            aria-label={`${label} 순으로 정렬${on ? (sort.descending ? ", 지금 내림차순" : ", 지금 오름차순") : ""}`}
            onClick={() => setSort(nextSort(sort, key))}
            className={`flex items-center gap-0.5 hover:text-text ${key === "name" ? "" : "justify-end"} ${on ? "font-[650] text-text-2" : ""}`}
          >
            {label}
            {on && <span aria-hidden="true">{sort.descending ? "↓" : "↑"}</span>}
          </button>
        );
      })}
    </div>
  );
}

function ResultRow({ row, period, asOf, active }: { row: ScreenerRow; period: ScreenPeriod; asOf: KstDate; active: boolean }) {
  const high = highDateText(period, row.highDate, asOf);
  return (
    <li data-code={row.symbol} className={`border-l-2 ${active ? "border-l-accent bg-surface" : "border-l-transparent"}`}>
      <button
        type="button"
        data-main
        aria-current={active || undefined}
        onClick={() => openResult(row.symbol)}
        style={ROW_GRID}
        className="grid w-full items-center gap-1 py-[5px] pl-[10px] pr-3 text-left hover:bg-surface"
      >
        <span className="min-w-0">
          <b className="block truncate font-[550]">{row.name}</b>
          <small className="text-xs text-text-3">{row.symbol}</small>
        </span>
        <span className="text-right">{formatPrice(row.close, false)}</span>
        <span className={`text-right text-s font-[550] ${row.changeRate === null ? "text-text-3" : DIR_CLASS[direction(row.changeRate)]}`}>
          {row.changeRate === null ? "—" : formatPercent(row.changeRate)}
        </span>
        <span className={`text-right text-s ${high.current ? "font-[650] text-accent" : "text-text-2"}`}>{high.text}</span>
      </button>
    </li>
  );
}

const PHASE_NOTE: Record<UpdatePhase, string> = {
  symbols: "종목 목록과 종목 상태를 새로 받습니다.",
  recent: "받는 동안에도 차트는 그대로 쓸 수 있습니다.",
  backfill: "지금도 실행할 수 있고, 아직 덜 찬 과거는 이력 부족으로 빠집니다.",
};

const progressText = ({ phase, done, total }: ScreenerUpdate) =>
  phase === "symbols" ? `${total > 0 ? Math.floor((done * 100) / total) : 0}%` : `${count(done)}/${count(total)}종목`;

const todayNote = (status: ScreenerStatus) => (status.todayAvailable ? "오늘 자료까지 받습니다." : "당일 봉은 20:00 뒤에 받습니다.");

function UpdateBand({ status }: { status: ScreenerStatus }) {
  const { start, cancel } = useUpdateCommands();
  const run = (full: boolean) => void start(full).catch(showCommandError);
  const update = status.update;
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

  if (update?.error) {
    return (
      <section aria-label="업데이트" role="alert" className={frame}>
        <div className="flex items-center gap-2">
          <span className="conn-dot" data-tone="red" />
          <span className="text-s font-[650]">업데이트가 멈췄습니다</span>
          <span className="flex-1" />
          <button type="button" className="btn-primary h-7 flex-none px-3 text-s" onClick={() => run(update.full)}>
            다시 시도
          </button>
        </div>
        <p className="mt-1.5 text-xs leading-[1.45] text-up">
          {PHASE_LABEL[update.phase]} {progressText(update)}에서 멈춤: {update.error.message}
        </p>
        <p className="mt-0.5 text-xs leading-[1.45] text-text-2">{stored} 다시 시도하면 남은 것만 받습니다.</p>
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

function StatusProblem({ query }: { query: UseQueryResult<ScreenerStatus> }) {
  return (
    <footer role={query.isError ? "alert" : undefined} className="flex flex-none items-center gap-2 border-t border-line px-3 py-2">
      <span className={`min-w-0 flex-1 truncate text-xs ${query.isError ? "text-up" : "text-text-3"}`}>
        {query.isError ? `저장소 상태를 읽지 못했습니다: ${query.error.message}` : "저장소 상태를 읽는 중"}
      </span>
      {query.isError && <RetryButton onClick={() => void query.refetch()} />}
    </footer>
  );
}

function StoreLine({ status, lastDay }: { status: ScreenerStatus; lastDay: KstDate }) {
  const { start } = useUpdateCommands();
  const today = todayNotStored(status);
  const history = status.fullHistory.done < status.fullHistory.total ? `과거 이력 ${count(status.fullHistory.done)}/${count(status.fullHistory.total)}종목` : null;
  const notes = [today ? "오늘 자료를 받을 수 있습니다" : status.todayAvailable ? "빠진 관측일 없음" : "당일 봉은 20:00 뒤에 받습니다", history].filter((n) => n !== null);
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
