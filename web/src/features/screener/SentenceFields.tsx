import { type RefObject, useId, useRef, useState } from "react";
import { EXCLUDE_LABEL, isBarKind, MARKET_LABEL, NO_CONDITIONS_SENTENCE, UNIT } from "../../lib/screener";
import { Choice, CHOICE_LABEL, fieldName, KindFields, NumberBox, PERIODS, Word, type LineUi } from "../screen-dialog/ConditionFields";
import { addCondition, changeKind, checkCondition, editCondition, editNumber, excludesIn, KIND_GROUPS, MARKETS, MAX_CONDITIONS, moveCondition, placeCondition, removeCondition, toggleExclude, toggleMarket, kindChoiceOf, type ConditionDraft, type FieldKey, type KindChoice, type ScreenDraft } from "../screen-dialog/screenForm";
import { ChevronIcon, CloseIcon, CopyIcon, GripIcon, MoreIcon, PlusIcon } from "../icons";
import { Popover } from "../overlay/Popover";
import { ScreenerMenu } from "./ScreenerMenu";

interface Props {
  draft: ScreenDraft;
  locked: boolean;
  ids?: string;
  onChange(change: (draft: ScreenDraft) => ScreenDraft): void;
}

const TARGET_ROW = "flex min-h-7 flex-wrap items-center gap-1 text-s text-text-2";
const ROW_ADD = "h-[var(--ctl-s)] w-[var(--ctl-s)] justify-center px-0";
export const CONDITIONS_NOTE = "최근 기간은 마지막 봉을 포함한 실제 봉 개수입니다. 봉이 없는 기간은 세지 않습니다.";

export function SentenceFields({ draft, locked, onChange }: Props) {
  return <fieldset data-chart-control disabled={locked} aria-label="문장형 조건식" className="min-w-0 space-y-3 border-0 px-3 pb-3 text-s disabled:opacity-60">
    <div className="space-y-1">
      <div className={TARGET_ROW} role="group" aria-label="대상 시장">
        <span className="mr-1">대상</span>
        {MARKETS.map((market) => <button key={market} type="button" aria-pressed={draft.markets.includes(market)} onClick={() => onChange((d) => toggleMarket(d, market))} className="ui-chip">{MARKET_LABEL[market]}</button>)}
        {draft.markets.length === 0 && <span className="text-text-3">두 시장 모두</span>}
      </div>
      {(["kind", "status"] as const).map((group) => <div key={group} className={TARGET_ROW} role="group" aria-label={group === "kind" ? "종류 제외" : "상태 제외"}>
        <span className="mr-1">{group === "kind" ? "종류 제외" : "상태 제외"}</span>
        {excludesIn(group).filter((kind) => draft.exclude.includes(kind)).map((kind) => <button key={kind} type="button" aria-label={`${EXCLUDE_LABEL[kind]} 제외 해제`} className="ui-chip" onClick={() => onChange((d) => toggleExclude(d, kind))}>{EXCLUDE_LABEL[kind]}<CloseIcon size={10} /></button>)}
        <ScreenerMenu label={group === "kind" ? "종류 제외 추가" : "상태 제외 추가"} className={ROW_ADD} items={excludesIn(group).map((kind) => ({ kind: "check", label: EXCLUDE_LABEL[kind], checked: draft.exclude.includes(kind), onSelect: () => onChange((d) => toggleExclude(d, kind)) }))}><PlusIcon size={12} /></ScreenerMenu>
      </div>)}
    </div>
    <SentenceConditions draft={draft} locked={locked} onChange={onChange} />
  </fieldset>;
}

function duplicateCondition(draft: ScreenDraft, key: number): ScreenDraft {
  const index = draft.conditions.findIndex((c) => c.key === key);
  const source = draft.conditions[index];
  if (!source || draft.conditions.length >= MAX_CONDITIONS) return draft;
  const copy: ConditionDraft = { ...source, key: Math.max(...draft.conditions.map((c) => c.key)) + 1 };
  return { ...draft, conditions: [...draft.conditions.slice(0, index + 1), copy, ...draft.conditions.slice(index + 1)] };
}

export function SentenceConditions({ draft, locked, ids: given, onChange }: Props) {
  const own = useId();
  const ids = given ?? own;
  const [dragKey, setDragKey] = useState<number | null>(null);
  const full = draft.conditions.length >= MAX_CONDITIONS;
  return <div className="space-y-2">
    {draft.conditions.length === 0 ? <p className="text-text-3">{NO_CONDITIONS_SENTENCE}</p> : <ol aria-label="조건" className="sentence-lines space-y-1">
      {draft.conditions.map((line, index) => <li key={line.key} className="flex gap-1.5 rounded-m px-1 py-1 hover:bg-[var(--hover)]" onDragOver={(e) => { if (dragKey !== null) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); if (dragKey !== null) onChange((d) => placeCondition(d, dragKey, line.key)); setDragKey(null); }}>
        <button type="button" draggable={!locked} aria-label={`조건 ${index + 1} 순서 끌어서 바꾸기`} title="끌어서 순서 바꾸기. 행 메뉴에서도 옮길 수 있습니다." className="mt-0.5 flex h-6 flex-none cursor-grab items-center text-text-2" onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(line.key)); setDragKey(line.key); }} onDragEnd={() => setDragKey(null)}><GripIcon size={14} /></button>
        <SentenceCondition ids={ids} line={line} index={index} onChange={(next) => onChange((d) => editCondition(d, next))} onKind={(kind) => onChange((d) => changeKind(d, line.key, kind))} />
        <ScreenerMenu label={`조건 ${index + 1} 메뉴`} className="h-6 w-6 justify-center px-0" items={[
          { kind: "action", label: "위로 옮기기", disabled: index === 0, onSelect: () => onChange((d) => moveCondition(d, line.key, -1)) },
          { kind: "action", label: "아래로 옮기기", disabled: index === draft.conditions.length - 1, onSelect: () => onChange((d) => moveCondition(d, line.key, 1)) },
          { kind: "action", label: "복제", icon: <CopyIcon size={14} />, disabled: full, onSelect: () => onChange((d) => duplicateCondition(d, line.key)) },
          { kind: "separator" },
          { kind: "action", label: "조건 지우기", danger: true, onSelect: () => onChange((d) => removeCondition(d, line.key)) },
        ]}><MoreIcon size={14} /></ScreenerMenu>
      </li>)}
    </ol>}
    <AddCondition disabled={full} onAdd={(kind) => onChange((d) => { const added = addCondition(d); const line = added.conditions.at(-1); return line ? changeKind(added, line.key, kind) : added; })} />
    <p className="text-xs text-text-2">모든 조건 충족 · {draft.conditions.length}/{MAX_CONDITIONS}줄 · {CONDITIONS_NOTE}</p>
  </div>;
}

interface LineProps {
  ids: string;
  line: ConditionDraft;
  index: number;
  onChange(line: ConditionDraft): void;
  onKind(kind: KindChoice): void;
}

export function SentenceCondition({ ids, line, index, onChange, onKind }: LineProps) {
  const checked = checkCondition(line);
  const kindButton = useRef<HTMLButtonElement>(null);
  const [kindQuery, setKindQuery] = useState<string | null>(null);
  const ui: LineUi = { label: `조건 ${index + 1}`, base: `${ids}-condition-${line.key}`, kind: kindChoiceOf(line), errors: checked.ok ? {} : checked.errors, numberPeriod: { value: line.period, apply: (field, value, period) => onChange(editNumber(line, field, value, period)) } };
  return <div className="min-w-0 flex-1">
    <div className="sentence-condition flex flex-wrap items-center gap-x-1 gap-y-1 leading-relaxed">
      {index > 0 && <span className="text-text-3">그리고</span>}
      <button ref={kindButton} type="button" aria-label={`${ui.label} 종류`} aria-haspopup="dialog" aria-expanded={kindQuery !== null} title="눌러서 종류 바꾸기" className="sentence-kind" onClick={() => setKindQuery("")}>{CHOICE_LABEL[ui.kind]}<ChevronIcon /></button>
      {kindQuery !== null && <KindSearch label={`${ui.label} 종류 바꾸기`} anchor={kindButton} query={kindQuery} current={ui.kind} onQuery={setKindQuery} onPick={(kind) => { setKindQuery(null); onKind(kind); }} onClose={() => setKindQuery(null)} />}
      {isBarKind(line.kind) && <>
        <Choice label={`${ui.label} 봉 주기`} value={line.period} options={PERIODS} onChange={(period) => onChange({ ...line, period })} />
        <span>최근</span>
        <Word><NumberBox ui={ui} field="recentBars" value={line.recentBars} onChange={(recentBars) => onChange({ ...line, recentBars })} />{UNIT[line.period]}</Word>
        <span>이내에</span>
      </>}
      <KindFields ui={ui} line={line} onChange={onChange} />
      {isBarKind(line.kind) && <span>봉이 있다</span>}
    </div>
    {(Object.entries(ui.errors) as [FieldKey, string][]).map(([key, message]) => <p key={key} id={`${ui.base}-${key}-error`} role="alert" className="mt-1 text-xs text-danger">{fieldName(ui.kind, key)}: {message}</p>)}
  </div>;
}

export const conditionChoices = (query: string) => KIND_GROUPS.flatMap((group) => group.kinds.map((kind) => ({ kind, group: group.label, label: CHOICE_LABEL[kind] }))).filter((choice) => `${choice.group} ${choice.label} ${choice.kind}`.toLowerCase().includes(query.trim().toLowerCase()));

function AddCondition({ disabled, onAdd }: { disabled: boolean; onAdd(kind: KindChoice): void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  return <>
    <button ref={anchor} type="button" data-add-condition disabled={disabled} aria-keyshortcuts="N" aria-expanded={query !== null} aria-haspopup="dialog" className="btn btn-sm w-full border-dashed text-text-2" onClick={() => setQuery("")}><PlusIcon size={14} />조건 추가</button>
    {query !== null && <KindSearch label="조건 추가" anchor={anchor} query={query} onQuery={setQuery} onPick={(kind) => { setQuery(null); onAdd(kind); }} onClose={() => setQuery(null)} />}
  </>;
}

interface SearchProps {
  label: string;
  anchor: RefObject<HTMLButtonElement | null>;
  query: string;
  current?: KindChoice;
  onQuery(query: string): void;
  onPick(kind: KindChoice): void;
  onClose(): void;
}

function KindSearch({ label, anchor, query, current, onQuery, onPick, onClose }: SearchProps) {
  const options = useRef<HTMLDivElement>(null);
  const choices = conditionChoices(query);
  const groups = KIND_GROUPS.map((group) => ({ label: group.label, choices: choices.filter((choice) => choice.group === group.label) })).filter((group) => group.choices.length > 0);
  return <Popover anchor={anchor} role="dialog" aria-label={label} onClose={onClose} className="flex max-h-[50vh] w-[260px] flex-col p-2">
    <input autoFocus aria-label="조건 종류 검색" className="ui-field w-full flex-none px-2" placeholder="신고가, 이동평균, RSI…" value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter" && choices[0]) { e.preventDefault(); onPick(choices[0].kind); }
      if (e.key === "ArrowDown") { e.preventDefault(); options.current?.querySelector("button")?.focus(); }
    }} />
    <div ref={options} aria-label="조건 종류" className="min-h-0 overflow-auto pt-1" onKeyDown={(e) => {
      const buttons = [...(options.current?.querySelectorAll("button") ?? [])];
      const index = buttons.findIndex((button) => button === document.activeElement);
      const next = e.key === "ArrowDown" ? index + 1 : e.key === "ArrowUp" ? index - 1 : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : null;
      if (next !== null) { e.preventDefault(); e.stopPropagation(); buttons[(next + buttons.length) % buttons.length]?.focus(); }
    }}>
      {groups.map((group) => <div key={group.label} role="group" aria-label={group.label}>
        <p aria-hidden="true" className="px-2 pb-0.5 pt-1.5 text-xs font-[600] text-text-2">{group.label}</p>
        {group.choices.map((choice) => <button key={choice.kind} type="button" aria-current={choice.kind === current || undefined} className="tb-btn flex h-8 w-full justify-start px-2 text-s aria-[current=true]:text-accent" onClick={() => onPick(choice.kind)}><span>{choice.label}</span></button>)}
      </div>)}
      {choices.length === 0 && <p className="p-2 text-s text-text-2">맞는 조건이 없습니다</p>}
    </div>
  </Popover>;
}
