import { type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { isTypingTarget } from "../../lib/typingTarget";
import { Popover } from "../overlay/Popover";
import type { Screen } from "../../api/generated/Screen";
import { conditionSentence, EXCLUDE_LABEL, excludedInOrder, MARKET_LABEL, marketsInOrder, NO_CONDITIONS_SENTENCE } from "../../lib/screener";
import type { MenuItem } from "../menu/Menu";
import { ChevronIcon, CloseIcon, PenIcon, PlayIcon, SpinnerIcon, Icon, DRAWING_ICONS, PlusIcon, CopyIcon } from "../icons";
import { ChangedBadge } from "./ChangedBadge";
import { ScreenerMenu } from "./ScreenerMenu";
import { SentenceFields } from "./SentenceFields";
import { dropPendingOpen } from "./resultActions";
import { type ChosenScreen, FIX_INVALID, type ScreenEditing, type ScreenEntry } from "./screenEditing";
import { removeChosen } from "./useScreenEditing";
import type { ScreenDraft } from "../screen-dialog/screenForm";

const KEEPS_DRAFT = "닫아도 편집 내용은 남습니다";
const BLOCKED_HINT = "자료 상태를 확인한 뒤 실행하세요";
export const PANEL_MENU = "스크리너 메뉴";

interface EditorProps {
  screenEditing: ScreenEditing;
  chosen: ChosenScreen;
  entries: readonly ScreenEntry[];
  blocked: boolean;
  menu(screenItems: readonly MenuItem[]): ReactNode;
  editing: boolean;
  onEditingChange(editing: boolean): void;
  onRun(): void;
}

export function SentenceEditor({ screenEditing, chosen, entries, blocked, menu, editing, onEditingChange, onRun }: EditorProps) {
  const section = useRef<HTMLElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const renameOpener = useRef<HTMLElement | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const { draft, runnable: checked, saving: busy, canSave, nameError, alerts, flagged } = chosen;
  const running = chosen.run?.kind === "running";
  const choose = (id: string) => { dropPendingOpen(); screenEditing.choose(id); };
  const change = (update: (draft: ScreenDraft) => ScreenDraft) => screenEditing.edit(update);
  const create = (copy = false) => { dropPendingOpen(); screenEditing.create(copy); onEditingChange(true); };
  const save = () => {
    void screenEditing.save();
    if (checked.ok) return;
    onEditingChange(true);
    requestAnimationFrame(() => section.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  };
  const screenItems: MenuItem[] = [
    { kind: "action", label: "저장", shortcut: "Ctrl+S", disabled: !canSave, onSelect: save },
    { kind: "action", label: "이름 바꾸기", onSelect: () => { renameOpener.current = head.current?.querySelector<HTMLElement>(`[aria-label="${PANEL_MENU}"]`) ?? null; setRename(draft.name); } },
    { kind: "action", label: "복제", icon: <CopyIcon size={14} />, onSelect: () => create(true) },
    { kind: "action", label: "새 조건식", icon: <PlusIcon />, onSelect: () => create() },
    { kind: "action", label: "지우기", icon: <Icon path={DRAWING_ICONS.trash} size={14} />, danger: true, onSelect: () => void removeChosen(screenEditing, chosen) },
  ];
  const invalid = !checked.ok;
  const summary = screenSummary(chosen.screen);
  return <section ref={section} aria-label="조건식 편집" className="flex-none border-b border-line">
    <div ref={head} data-chart-control className="flex h-11 items-center gap-1 pl-2 pr-1.5">
      <fieldset disabled={busy} className="contents">
        <ScreenerMenu label="조건식 고르기" items={entries.map((entry) => ({ kind: "radio", label: entry.title, checked: entry.source.id === chosen.source.id, onSelect: () => choose(entry.source.id) }))}><span className="truncate text-l font-semibold">{chosen.title}</span><ChevronIcon /></ScreenerMenu>
        {chosen.dirty && <ChangedBadge />}
      </fieldset>
      <span className="min-w-1 flex-1" />
      {!editing && chosen.dirty && <button type="button" title="저장 (Ctrl+S)" className="btn btn-sm flex-none" disabled={!canSave} onClick={save}>{busy ? "저장 중" : "저장"}</button>}
      <button ref={opener} type="button" aria-haspopup="dialog" aria-expanded={editing} className="btn btn-sm flex-none gap-1 aria-expanded:border-accent aria-expanded:text-accent" onClick={() => onEditingChange(!editing)}><PenIcon size={14} />편집</button>
      <RunButton running={running} disabled={blocked || running || busy || invalid} title={blocked ? BLOCKED_HINT : undefined} onRun={onRun} />
      {menu(screenItems)}
    </div>
    <p data-screen-summary title={summary.full} className="-mt-1 truncate px-3 pb-2 text-s text-text-2">{summary.line}</p>
    {rename !== null && <Popover anchor={head} focusTarget={renameOpener} role="dialog" aria-label="조건식 이름 바꾸기" onClose={() => setRename(null)} className="p-3">
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); change((d) => ({ ...d, name: rename })); setRename(null); }}>
        <label className="text-s">조건식 이름<input autoFocus aria-label="조건식 이름" value={rename} onChange={(e) => setRename(e.target.value)} className="ui-field mt-1 w-full px-2" /></label>
        <button type="submit" className="btn-primary h-8">적용</button>
      </form>
    </Popover>}
    {blocked && <p className="px-3 pb-2 text-xs text-warning">{BLOCKED_HINT}</p>}
    {!editing && nameError && <p role="alert" className="px-3 pb-2 text-xs text-danger">{nameError}</p>}
    {invalid && !alerts.includes(FIX_INVALID) && <p className="px-3 pb-2 text-xs text-warning">{FIX_INVALID}</p>}
    {!editing && alerts.map((message) => <p key={message} role="alert" className="px-3 pb-2 text-xs text-danger">{message}</p>)}
    {editing && <EditorWindow draft={draft} section={section} opener={opener} flagged={flagged} nameError={nameError} canSave={canSave} busy={busy} running={running} blocked={blocked} alerts={alerts} onChange={change} onClose={() => onEditingChange(false)} onSave={save} onRun={onRun} />}
  </section>;
}

function screenSummary(screen: Screen): { line: string; full: string } {
  const markets = marketsInOrder(screen.markets).map((market) => MARKET_LABEL[market]).join("·");
  const excluded = excludedInOrder(screen.exclude).map((kind) => EXCLUDE_LABEL[kind]).join("·");
  const scope = [markets || "두 시장", excluded && `${excluded} 제외`].filter(Boolean).join(" · ");
  const sentences = screen.conditions.map(conditionSentence);
  if (sentences.length === 0) return { line: `${scope} · ${NO_CONDITIONS_SENTENCE}`, full: `${scope}\n${NO_CONDITIONS_SENTENCE}` };
  return { line: `${scope} · 조건 ${sentences.length}개: ${sentences.join(", ")}`, full: [scope, ...sentences.map((sentence, index) => `${index + 1}. ${sentence}`)].join("\n") };
}

function RunButton({ running, disabled, title = "실행 (Ctrl+Enter)", onRun }: { running: boolean; disabled: boolean; title?: string; onRun(): void }) {
  return <button type="button" title={title} aria-keyshortcuts="Control+Enter Meta+Enter" className="btn-primary btn-sm flex flex-none items-center gap-1" disabled={disabled} onClick={onRun}>{running ? <SpinnerIcon /> : <PlayIcon />}{running ? "실행 중" : "실행"}</button>;
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
