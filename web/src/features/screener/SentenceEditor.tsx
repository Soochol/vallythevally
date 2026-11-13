import { type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { Screen } from "../../api/generated/Screen";
import { isTypingTarget } from "../../lib/hotkeys";
import { conditionSentence, EXCLUDE_LABEL, excludedInOrder, MARKET_LABEL, marketsInOrder, NO_CONDITIONS_SENTENCE } from "../../lib/screener";
import { Popover } from "../overlay/Popover";
import { ChevronIcon, CloseIcon, MoreIcon, PenIcon, PlayIcon, SpinnerIcon } from "../icons";
import { ChangedBadge } from "./ChangedBadge";
import { ScreenerMenu } from "./ScreenerMenu";
import { SentenceFields } from "./SentenceFields";
import { dropPendingOpen } from "./resultActions";
import { type ChosenScreen, FIX_INVALID, type ScreenEditing, type ScreenEntry } from "./screenEditing";
import { removeChosen } from "./useScreenEditing";
import type { ScreenDraft } from "../screen-dialog/screenForm";

const SUMMARY_LINES = 3;
const KEEPS_DRAFT = "닫아도 편집 내용은 남습니다";
const BLOCKED_HINT = "자료 상태를 확인한 뒤 실행하세요";
const RUNS_UNSAVED = "저장 전에도 실행할 수 있습니다";

interface EditorProps {
  screenEditing: ScreenEditing;
  chosen: ChosenScreen;
  entries: readonly ScreenEntry[];
  blocked: boolean;
  resultActions: ReactNode;
  wide: boolean;
  editing: boolean;
  onEditingChange(editing: boolean): void;
  onRun(): void;
}

function scopeSummary(screen: Screen): string {
  const markets = marketsInOrder(screen.markets).map((market) => MARKET_LABEL[market]).join("·") || "전 종목 대상";
  const excluded = excludedInOrder(screen.exclude).map((kind) => EXCLUDE_LABEL[kind]).join("·");
  return excluded ? `${markets} · ${excluded} 제외` : markets;
}

export function SentenceEditor({ screenEditing, chosen, entries, blocked, resultActions, wide, editing, onEditingChange, onRun }: EditorProps) {
  const section = useRef<HTMLElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const renameOpener = useRef<HTMLElement | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const { draft, runnable: checked, saving: busy, canSave, nameError, alerts, flagged } = chosen;
  const running = chosen.run?.kind === "running";
  const inline = wide && (editing || flagged);
  const floating = !wide && editing;
  const lines = checked.ok ? checked.screen.conditions.map(conditionSentence) : [];
  const choose = (id: string) => { dropPendingOpen(); screenEditing.choose(id); };
  const change = (update: (draft: ScreenDraft) => ScreenDraft) => screenEditing.edit(update);
  const create = (copy = false) => { dropPendingOpen(); screenEditing.create(copy); onEditingChange(true); };
  const save = () => {
    void screenEditing.save();
    if (checked.ok) return;
    onEditingChange(true);
    requestAnimationFrame(() => section.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  };
  return <section ref={section} aria-label="조건식 편집" className="flex-none border-b border-line">
    <div ref={head} data-chart-control className="flex flex-wrap items-center gap-1 px-3 py-2">
      <fieldset disabled={busy} className="contents">
        <ScreenerMenu label="조건식 고르기" items={entries.map((entry) => ({ kind: "radio", label: entry.title, checked: entry.source.id === chosen.source.id, onSelect: () => choose(entry.source.id) }))}><span className="truncate text-l font-semibold">{chosen.title}</span><ChevronIcon /></ScreenerMenu>
        {chosen.dirty && <ChangedBadge />}
        <span className="flex-1" />
        {wide && <button type="button" className="tb-btn h-7 px-2 text-s" aria-expanded={inline} onClick={() => onEditingChange(!inline)}>{inline ? "조건 접기" : "조건 펼치기"}</button>}
        {!floating && <button type="button" className="tb-btn h-7 px-2 text-s disabled:opacity-40" disabled={!canSave} onClick={save}>{busy ? "저장 중" : "저장"}</button>}
        <ScreenerMenu label="조건식 메뉴" items={[
          { kind: "action", label: "이름 바꾸기", onSelect: () => { renameOpener.current = head.current?.querySelector<HTMLElement>('[aria-label="조건식 메뉴"]') ?? null; setRename(draft.name); } },
          { kind: "action", label: "새 조건식", onSelect: () => create() },
          { kind: "action", label: "복제", onSelect: () => create(true) },
          { kind: "separator" },
          { kind: "action", label: "지우기", onSelect: () => void removeChosen(screenEditing, chosen) },
        ]}><MoreIcon size={16} /></ScreenerMenu>
      </fieldset>
    </div>
    {rename !== null && <Popover anchor={head} focusTarget={renameOpener} role="dialog" aria-label="조건식 이름 바꾸기" onClose={() => setRename(null)} className="p-3">
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); change((d) => ({ ...d, name: rename })); setRename(null); }}>
        <label className="text-s">조건식 이름<input autoFocus aria-label="조건식 이름" value={rename} onChange={(e) => setRename(e.target.value)} className="ui-field mt-1 w-full px-2" /></label>
        <button type="submit" className="btn-primary h-8">적용</button>
      </form>
    </Popover>}
    {!floating && nameError && <p role="alert" className="px-3 pb-2 text-xs text-danger">{nameError}</p>}
    {inline ? <SentenceFields draft={draft} locked={busy} onChange={change} /> : <div aria-label="조건 요약" className="px-3 pb-3 text-s text-text-2">
      {!checked.ok && <p>{FIX_INVALID}</p>}
      {checked.ok && lines.length === 0 && <p>{NO_CONDITIONS_SENTENCE}</p>}
      {lines.slice(0, SUMMARY_LINES).map((line, index) => <p key={index} className="truncate" title={line}>{line}</p>)}
      {lines.length > SUMMARY_LINES && <p className="text-text-3">외 {lines.length - SUMMARY_LINES}개 조건</p>}
      {checked.ok && <p className="truncate text-xs text-text-3" title={scopeSummary(checked.screen)}>{scopeSummary(checked.screen)}</p>}
    </div>}
    <div data-chart-control className="flex items-center gap-2 px-3 pb-3">
      <RunButton running={running} disabled={blocked || running || busy} onRun={onRun} />
      {!wide && <button ref={opener} type="button" aria-haspopup="dialog" aria-expanded={editing} className="tb-btn h-8 flex-none gap-1 border border-line px-2 text-s aria-expanded:border-accent aria-expanded:text-accent" onClick={() => onEditingChange(!editing)}><PenIcon size={14} />편집</button>}
      <span className="min-w-0 truncate text-xs text-text-3" title={blocked ? BLOCKED_HINT : RUNS_UNSAVED}>{blocked ? BLOCKED_HINT : RUNS_UNSAVED}</span>
      <span className="flex-1" />{resultActions}
    </div>
    {!floating && alerts.map((message) => <p key={message} role="alert" className="px-3 pb-2 text-xs text-danger">{message}</p>)}
    {floating && <EditorWindow draft={draft} section={section} opener={opener} flagged={flagged} nameError={nameError} canSave={canSave} busy={busy} running={running} blocked={blocked} alerts={alerts} onChange={change} onClose={() => onEditingChange(false)} onSave={save} onRun={onRun} />}
  </section>;
}

function RunButton({ running, disabled, onRun }: { running: boolean; disabled: boolean; onRun(): void }) {
  return <button type="button" title="실행 (Ctrl+Enter)" aria-keyshortcuts="Control+Enter Meta+Enter" className="btn-primary flex h-8 flex-none items-center gap-1 px-3 text-s disabled:opacity-40" disabled={disabled} onClick={onRun}>{running ? <SpinnerIcon /> : <PlayIcon />}{running ? "실행 중" : "실행"}</button>;
}

interface WindowProps {
  draft: ScreenDraft;
  section: RefObject<HTMLElement | null>;
  opener: RefObject<HTMLButtonElement | null>;
  flagged: boolean;
  nameError: string | null;
  canSave: boolean;
  busy: boolean;
  running: boolean;
  blocked: boolean;
  alerts: readonly string[];
  onChange(update: (draft: ScreenDraft) => ScreenDraft): void;
  onClose(): void;
  onSave(): void;
  onRun(): void;
}

function EditorWindow({ draft, section, opener, flagged, nameError, canSave, busy, running, blocked, alerts, onChange, onClose, onSave, onRun }: WindowProps) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const invalid = flagged ? body.current?.parentElement?.querySelector<HTMLElement>('[aria-invalid="true"]') : null;
    (invalid ?? body.current)?.focus();
  }, [flagged]);
  const panelOf = () => section.current?.closest("aside") ?? null;
  const beside = () => {
    const panel = panelOf()?.getBoundingClientRect();
    const own = section.current?.getBoundingClientRect();
    return panel && own ? { left: panel.left, right: panel.right, top: own.top, bottom: own.bottom } : undefined;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || !(event.target instanceof Element) || event.target.closest("[popover]") !== event.currentTarget) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key === "Enter") { event.preventDefault(); onRun(); }
    else if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); onSave(); }
    else if (!command && !event.altKey && event.key.toLowerCase() === "n" && !isTypingTarget(event.target)) { event.preventDefault(); event.currentTarget.querySelector<HTMLButtonElement>("[data-add-condition]")?.click(); }
  };
  return <Popover role="dialog" aria-label="조건 편집 창" anchor={opener} anchorRect={beside} placement="left" focus={false} blockChartKeys={false} isInside={(target) => panelOf()?.contains(target) ?? false} onClose={onClose} onKeyDown={onKeyDown} className="flex w-[476px] flex-col">
    <header className="flex flex-none items-center gap-2 border-b border-line py-2 pl-3 pr-2">
      <input aria-label="조건식 이름" aria-invalid={nameError !== null} disabled={busy} autoComplete="off" value={draft.name} onChange={(e) => onChange((d) => ({ ...d, name: e.target.value }))} className="min-w-0 flex-1 rounded-m border border-transparent bg-transparent px-2 py-1 text-l font-semibold text-text outline-none hover:border-line focus:border-accent aria-invalid:border-danger" />
      <button type="button" className="icon-btn flex-none" aria-label="닫기" title="닫기 (Esc)" onClick={onClose}><CloseIcon /></button>
    </header>
    <div ref={body} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto pt-3 outline-none">
      <SentenceFields draft={draft} locked={busy} onChange={onChange} />
    </div>
    <footer className="flex flex-none items-center gap-2 border-t border-line px-3 py-2">
      <div className="min-w-0 flex-1 text-xs">
        {[nameError, ...alerts].map((message) => message && <p key={message} role="alert" className="text-danger">{message}</p>)}
        {nameError === null && alerts.length === 0 && <p className="text-text-3">{KEEPS_DRAFT}</p>}
      </div>
      <button type="button" title="저장 (Ctrl+S)" aria-keyshortcuts="Control+S Meta+S" className="tb-btn h-8 flex-none border border-line px-3 text-s disabled:opacity-40" disabled={!canSave} onClick={onSave}>{busy ? "저장 중" : "저장"}</button>
      <RunButton running={running} disabled={blocked || running || busy} onRun={onRun} />
    </footer>
  </Popover>;
}
