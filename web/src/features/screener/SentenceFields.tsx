import { useId, useRef, useState } from "react";
import { EXCLUDE_LABEL, MARKET_LABEL, NO_CONDITIONS_SENTENCE } from "../../lib/screener";
import { Choice, CHOICE_LABEL, fieldName, KindFields, NumberBox, PERIODS, type LineUi } from "../screen-dialog/ConditionFields";
import { addCondition, changeKind, checkCondition, editCondition, editNumber, excludesIn, KIND_GROUPS, MARKETS, MAX_CONDITIONS, moveCondition, placeCondition, removeCondition, toggleExclude, toggleMarket, kindChoiceOf, type ConditionDraft, type FieldKey, type KindChoice, type ScreenDraft } from "../screen-dialog/screenForm";
import { CloseIcon, GripIcon, MoreIcon, PlusIcon } from "../icons";
import { Popover } from "../overlay/Popover";
import { ScreenerMenu } from "./ScreenerMenu";

interface Props {
  draft: ScreenDraft;
  locked: boolean;
  onChange(change: (draft: ScreenDraft) => ScreenDraft): void;
}

export function SentenceFields({ draft, locked, onChange }: Props) {
  const ids = useId();
  const [dragKey, setDragKey] = useState<number | null>(null);
  return <fieldset data-chart-control disabled={locked} aria-label="문장형 조건식" className="min-w-0 space-y-3 border-0 px-3 pb-3 text-s disabled:opacity-60">
    <div className="flex flex-wrap items-center gap-1 text-xs text-text-2" role="group" aria-label="대상 시장">
      <span>대상</span>
      {MARKETS.map((market) => <button key={market} type="button" aria-pressed={draft.markets.includes(market)} onClick={() => onChange((d) => toggleMarket(d, market))} className="rounded-s border border-line px-2 py-1 aria-pressed:border-accent aria-pressed:text-accent">{MARKET_LABEL[market]}</button>)}
      {draft.markets.length === 0 && <span className="text-text-3">두 시장 모두</span>}
    </div>
    {(["kind", "status"] as const).map((group) => <div key={group} className="flex flex-wrap items-center gap-1 text-xs text-text-2" role="group" aria-label={group === "kind" ? "종류 제외" : "상태 제외"}>
      <span>{group === "kind" ? "종류 제외" : "상태 제외"}</span>
      {excludesIn(group).filter((kind) => draft.exclude.includes(kind)).map((kind) => <button key={kind} type="button" aria-label={`${EXCLUDE_LABEL[kind]} 제외 해제`} className="flex items-center gap-1 rounded-s border border-line px-2 py-1" onClick={() => onChange((d) => toggleExclude(d, kind))}>{EXCLUDE_LABEL[kind]}<CloseIcon size={10} /></button>)}
      <ScreenerMenu label={group === "kind" ? "종류 제외 추가" : "상태 제외 추가"} items={excludesIn(group).map((kind) => ({ kind: "check", label: EXCLUDE_LABEL[kind], checked: draft.exclude.includes(kind), onSelect: () => onChange((d) => toggleExclude(d, kind)) }))}><PlusIcon size={12} /></ScreenerMenu>
    </div>)}
    {draft.conditions.length === 0 ? <p className="text-text-3">{NO_CONDITIONS_SENTENCE}</p> : <ol aria-label="조건" className="space-y-2">
      {draft.conditions.map((line, index) => <li key={line.key} className="flex gap-1 rounded-s border border-transparent py-1 hover:border-line" onDragOver={(e) => { if (dragKey !== null) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); if (dragKey !== null) onChange((d) => placeCondition(d, dragKey, line.key)); setDragKey(null); }}>
        <button type="button" draggable={!locked} aria-label={`조건 ${index + 1} 순서 끌어서 바꾸기`} title="끌어서 순서 바꾸기. 행 메뉴에서도 옮길 수 있습니다." className="mt-1 flex-none cursor-grab text-text-3" onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(line.key)); setDragKey(line.key); }} onDragEnd={() => setDragKey(null)}><GripIcon size={14} /></button>
        <SentenceCondition ids={ids} line={line} index={index} onChange={(next) => onChange((d) => editCondition(d, next))} />
        <ScreenerMenu label={`조건 ${index + 1} 메뉴`} items={[
          { kind: "action", label: "위로 옮기기", disabled: index === 0, onSelect: () => onChange((d) => moveCondition(d, line.key, -1)) },
          { kind: "action", label: "아래로 옮기기", disabled: index === draft.conditions.length - 1, onSelect: () => onChange((d) => moveCondition(d, line.key, 1)) },
          { kind: "action", label: "조건 지우기", onSelect: () => onChange((d) => removeCondition(d, line.key)) },
          { kind: "separator" },
          { kind: "heading", label: "종류 바꾸기" },
          ...conditionChoices("").map((choice) => ({ kind: "radio" as const, label: choice.label, checked: kindChoiceOf(line) === choice.kind, onSelect: () => onChange((d) => changeKind(d, line.key, choice.kind)) })),
        ]}><MoreIcon size={14} /></ScreenerMenu>
      </li>)}
    </ol>}
    <ConditionSearch disabled={draft.conditions.length >= MAX_CONDITIONS} onAdd={(kind) => onChange((d) => { const added = addCondition(d); const line = added.conditions.at(-1); return line ? changeKind(added, line.key, kind) : added; })} />
    <p className="text-xs text-text-3">모든 조건 충족 · {draft.conditions.length}/{MAX_CONDITIONS}줄 · 0봉은 마지막 실제 봉</p>
  </fieldset>;
}

export function SentenceCondition({ ids, line, index, onChange }: { ids: string; line: ConditionDraft; index: number; onChange(line: ConditionDraft): void }) {
  const checked = checkCondition(line);
  const ui: LineUi = { label: `조건 ${index + 1}`, base: `${ids}-condition-${line.key}`, kind: kindChoiceOf(line), errors: checked.ok ? {} : checked.errors, sentence: true, numberPeriod: { value: line.period, apply: (field, value, period) => onChange(editNumber(line, field, value, period)) } };
  return <div className="min-w-0 flex-1">
    <div className="sentence-condition flex flex-wrap items-center gap-x-1 gap-y-1 leading-relaxed">
      {index > 0 && <span className="text-text-3">그리고</span>}
      {line.kind !== "market_cap" && <>
        <Choice label={`${ui.label} 봉 주기`} value={line.period} options={PERIODS} onChange={(period) => onChange({ ...line, period })} />
        <NumberBox ui={ui} field="rangeStart" value={line.rangeStart} onChange={(rangeStart) => onChange({ ...line, rangeStart })} />
        <span>~</span>
        <NumberBox ui={ui} field="rangeEnd" value={line.rangeEnd} onChange={(rangeEnd) => onChange({ ...line, rangeEnd })} />
        <span>봉 전 안에</span>
      </>}
      {line.kind === "market_cap" && <span>시가총액이</span>}
      <KindFields ui={ui} line={line} onChange={onChange} />
      <span>{line.kind === "market_cap" ? "이다" : "인 봉이 있다"}</span>
    </div>
    {(Object.entries(ui.errors) as [FieldKey, string][]).map(([key, message]) => <p key={key} id={`${ui.base}-${key}-error`} role="alert" className="mt-1 text-xs text-danger">{fieldName(ui.kind, key)}: {message}</p>)}
  </div>;
}

export const conditionChoices = (query: string) => KIND_GROUPS.flatMap((group) => group.kinds.map((kind) => ({ kind, group: group.label, label: CHOICE_LABEL[kind] }))).filter((choice) => `${choice.group} ${choice.label} ${choice.kind}`.toLowerCase().includes(query.trim().toLowerCase()));

function ConditionSearch({ disabled, onAdd }: { disabled: boolean; onAdd(kind: KindChoice): void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const choices = conditionChoices(query ?? "");
  const add = (kind: KindChoice) => { onAdd(kind); setQuery(null); };
  return <>
    <button ref={anchor} type="button" disabled={disabled} aria-expanded={query !== null} aria-haspopup="dialog" className="tb-btn h-8 w-full gap-1 border border-dashed border-line text-text-2 disabled:opacity-40" onClick={() => setQuery("")}><PlusIcon size={14} />조건 추가</button>
    {query !== null && <Popover anchor={anchor} role="dialog" aria-label="조건 추가" onClose={() => setQuery(null)} className="flex max-h-[50vh] w-[260px] flex-col rounded-m border border-line bg-surface p-2 shadow-dialog">
      <input autoFocus aria-label="조건 종류 검색" className="ui-field w-full flex-none px-2" placeholder="신고가, 이동평균, RSI…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter" && choices[0]) { e.preventDefault(); add(choices[0].kind); }
        if (e.key === "ArrowDown") { e.preventDefault(); options.current?.querySelector("button")?.focus(); }
      }} />
      <div ref={options} aria-label="조건 종류" className="min-h-0 overflow-auto pt-1" onKeyDown={(e) => {
        const buttons = [...(options.current?.querySelectorAll("button") ?? [])];
        const index = buttons.findIndex((button) => button === document.activeElement);
        const next = e.key === "ArrowDown" ? index + 1 : e.key === "ArrowUp" ? index - 1 : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : null;
        if (next !== null) { e.preventDefault(); e.stopPropagation(); buttons[(next + buttons.length) % buttons.length]?.focus(); }
      }}>{choices.map((choice) => <button key={choice.kind} type="button" className="tb-btn flex h-8 w-full justify-between px-2 text-s" onClick={() => add(choice.kind)}><span>{choice.label}</span><small className="text-text-3">{choice.group}</small></button>)}{choices.length === 0 && <p className="p-2 text-s text-text-3">맞는 조건이 없습니다</p>}</div>
    </Popover>}
  </>;
}
