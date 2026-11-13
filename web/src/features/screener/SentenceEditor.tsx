import { type ReactNode, useRef, useState } from "react";
import { conditionSentence, NO_CONDITIONS_SENTENCE } from "../../lib/screener";
import { confirmAction } from "../overlay/Confirm";
import { Popover } from "../overlay/Popover";
import { ChevronIcon, MoreIcon, PlayIcon, SpinnerIcon } from "../icons";
import type { ScreenDraft } from "../screen-dialog/screenForm";
import { ScreenerMenu } from "./ScreenerMenu";
import { SentenceFields } from "./SentenceFields";
import { dropPendingOpen } from "./resultActions";
import type { ChosenScreen, ScreenEntry, Workspace } from "./workspace";

export function SentenceEditor({ workspace, chosen, draft, entries, blocked, resultActions, wide, expanded, onExpandedChange, onRun }: { workspace: Workspace; chosen: ChosenScreen; draft: ScreenDraft; entries: readonly ScreenEntry[]; blocked: boolean; resultActions: ReactNode; wide: boolean; expanded: boolean; onExpandedChange(expanded: boolean): void; onRun(): void }) {
  const anchor = useRef<HTMLDivElement>(null);
  const renameOpener = useRef<HTMLElement | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const checked = chosen.runnable;
  const busy = chosen.saving;
  const running = chosen.run?.kind === "running";
  const showFields = !wide || expanded || (chosen.tried && !checked.ok);
  const summary = checked.ok ? checked.screen.conditions.map(conditionSentence).join(" · ") || NO_CONDITIONS_SENTENCE : "조건식의 잘못된 값을 고쳐 주세요";
  const choose = (id: string) => { dropPendingOpen(); workspace.choose(id); };
  const create = (copy = false) => { dropPendingOpen(); workspace.create(copy); onExpandedChange(true); };
  const remove = async () => {
    if (!await confirmAction(`"${draft.name}" 조건식을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    if (await workspace.remove()) dropPendingOpen();
  };
  return <section aria-label="조건식 편집" className="flex-none border-b border-line">
    <div ref={anchor} data-chart-control className="flex flex-wrap items-center gap-1 px-3 py-2">
      <fieldset disabled={busy} className="contents">
        <ScreenerMenu label="조건식 고르기" items={entries.map((entry) => ({ kind: "radio", label: (entry.draft?.name ?? entry.source.name) || "이름 없음", checked: entry.source.id === chosen.source.id, onSelect: () => choose(entry.source.id) }))}><span className="truncate text-l font-semibold">{draft.name || "이름 없음"}</span><ChevronIcon /></ScreenerMenu>
        {chosen.dirty && <span className="rounded-s border border-warning px-1 text-xs text-warning">변경됨</span>}
        <span className="flex-1" />
        {wide && <button type="button" className="tb-btn h-7 px-2 text-s" aria-expanded={showFields} onClick={() => onExpandedChange(!showFields)}>{showFields ? "조건 접기" : "조건 펼치기"}</button>}
        <button type="button" className="tb-btn h-7 px-2 text-s disabled:opacity-40" disabled={!chosen.dirty} onClick={() => {
          void workspace.save();
          if (!checked.ok) requestAnimationFrame(() => {
            anchor.current?.parentElement?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
          });
        }}>{busy ? "저장 중" : "저장"}</button>
        <ScreenerMenu label="조건식 메뉴" items={[
          { kind: "action", label: "이름 바꾸기", onSelect: () => { renameOpener.current = anchor.current?.querySelector<HTMLElement>('[aria-label="조건식 메뉴"]') ?? null; setRename(draft.name); } },
          { kind: "action", label: "새 조건식", onSelect: () => create() },
          { kind: "action", label: "복제", onSelect: () => create(true) },
          { kind: "separator" },
          { kind: "action", label: "지우기", onSelect: () => void remove() },
        ]}><MoreIcon size={16} /></ScreenerMenu>
      </fieldset>
    </div>
    {rename !== null && <Popover anchor={anchor} focusTarget={renameOpener} role="dialog" aria-label="조건식 이름 바꾸기" onClose={() => setRename(null)} className="rounded-m border border-line bg-surface p-3 shadow-dialog">
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); workspace.edit((d) => ({ ...d, name: rename })); setRename(null); }}>
        <label className="text-s">조건식 이름<input autoFocus aria-label="조건식 이름" value={rename} onChange={(e) => setRename(e.target.value)} className="ui-field mt-1 w-full px-2" /></label>
        <button type="submit" className="btn-primary h-8">적용</button>
      </form>
    </Popover>}
    {chosen.nameError && <p role="alert" className="px-3 pb-2 text-xs text-danger">{chosen.nameError}</p>}
    {showFields ? <SentenceFields draft={draft} locked={busy} onChange={(update) => workspace.edit(update)} /> : <p className="truncate px-3 pb-3 text-s text-text-2" title={summary}>{summary}</p>}
    <div data-chart-control className="flex items-center gap-2 px-3 pb-3">
      <button type="button" title="실행 (Ctrl+Enter)" aria-keyshortcuts="Control+Enter Meta+Enter" className="btn-primary flex h-8 items-center gap-1 px-3 text-s disabled:opacity-40" disabled={blocked || running || busy} onClick={onRun}>{running ? <SpinnerIcon /> : <PlayIcon />}{running ? "실행 중" : "실행"}</button>
      <span className="text-xs text-text-3">{blocked ? "자료 상태를 확인한 뒤 실행하세요" : "저장 전에도 실행할 수 있습니다"}</span>
      <span className="flex-1" />{resultActions}
    </div>
    {chosen.tried && !checked.ok && <p role="alert" className="px-3 pb-2 text-xs text-danger">{checked.errors.list ?? "조건식의 잘못된 값을 고쳐 주세요"}</p>}
    {chosen.notice && <p role="alert" className="px-3 pb-2 text-xs text-danger">{chosen.notice}</p>}
  </section>;
}
