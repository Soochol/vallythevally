import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { useScreenerStore } from "../../stores/screener";
import { confirmAction } from "../overlay/Confirm";
import { Popover } from "../overlay/Popover";
import { ChevronIcon, MoreIcon, PlayIcon, SpinnerIcon } from "../icons";
import { checkedSession, isDirty, useScreenEditor, type EditorSession } from "./editorState";
import { ScreenerMenu } from "./ScreenerMenu";
import { SentenceFields } from "./SentenceFields";

export function SentenceEditor({ session, base, source, running, blocked, resultActions, onRun }: { session: EditorSession; base: Screens; source: Screen; running: boolean; blocked: boolean; resultActions: ReactNode; onRun(): void }) {
  const client = useQueryClient();
  const anchor = useRef<HTMLDivElement>(null);
  const renameOpener = useRef<HTMLElement | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const sessions = useScreenEditor((s) => s.sessions);
  const editor = useScreenEditor.getState();
  const checked = checkedSession(session);
  const busy = session.saving.kind === "saving";
  const nameError = !checked.ok && (session.tried || session.draft.name !== session.initial?.name) ? checked.errors.name : null;
  const create = (copy = false) => useScreenerStore.getState().choose(editor.create(base, copy ? session.draft : undefined));
  const screens = [...base.screens, ...Object.values(sessions).filter((s) => s.initial === null && !base.screens.some((screen) => screen.id === s.source.id)).map((s) => ({ ...s.source, name: s.draft.name }))];
  const remove = async () => {
    if (!await confirmAction(`"${session.draft.name}" 조건식을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    if (await editor.remove(client, base, source)) useScreenerStore.getState().choose(base.screens.find((s) => s.id !== source.id)?.id ?? "");
  };
  return <section aria-label="조건식 편집" className="flex-none border-b border-line">
    <div ref={anchor} data-chart-control className="flex flex-wrap items-center gap-1 px-3 py-2">
      <fieldset disabled={busy} className="contents">
        <ScreenerMenu label="조건식 고르기" items={screens.map((screen) => ({ kind: "radio", label: screen.name || "이름 없음", checked: screen.id === source.id, onSelect: () => useScreenerStore.getState().choose(screen.id) }))}><span className="truncate text-l font-semibold">{session.draft.name || "이름 없음"}</span><ChevronIcon /></ScreenerMenu>
        {isDirty(session) && <span className="rounded-s border border-warning px-1 text-xs text-warning">변경됨</span>}
        <span className="flex-1" />
        <button type="button" className="tb-btn h-7 px-2 text-s disabled:opacity-40" disabled={!isDirty(session)} onClick={() => void editor.save(client, base, source)}>{busy ? "저장 중" : "저장"}</button>
        <ScreenerMenu label="조건식 메뉴" items={[
          { kind: "action", label: "이름 바꾸기", onSelect: () => { renameOpener.current = anchor.current?.querySelector<HTMLElement>('[aria-label="조건식 메뉴"]') ?? null; setRename(session.draft.name); } },
          { kind: "action", label: "새 조건식", onSelect: () => create() },
          { kind: "action", label: "복제", onSelect: () => create(true) },
          { kind: "separator" },
          { kind: "action", label: "지우기", onSelect: () => void remove() },
        ]}><MoreIcon size={16} /></ScreenerMenu>
      </fieldset>
    </div>
    {rename !== null && <Popover anchor={anchor} focusTarget={renameOpener} role="dialog" aria-label="조건식 이름 바꾸기" onClose={() => setRename(null)} className="rounded-m border border-line bg-surface p-3 shadow-dialog">
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); editor.change(base, source, (d) => ({ ...d, name: rename })); setRename(null); }}>
        <label className="text-s">조건식 이름<input autoFocus aria-label="조건식 이름" value={rename} onChange={(e) => setRename(e.target.value)} className="ui-field mt-1 w-full px-2" /></label>
        <button type="submit" className="btn-primary h-8">적용</button>
      </form>
    </Popover>}
    {nameError && <p role="alert" className="px-3 pb-2 text-xs text-danger">{nameError}</p>}
    <SentenceFields draft={session.draft} locked={busy} onChange={(update) => editor.change(base, source, update)} />
    <div data-chart-control className="flex items-center gap-2 px-3 pb-3">
      <button type="button" title="실행 (Ctrl+Enter)" className="btn-primary flex h-8 items-center gap-1 px-3 text-s disabled:opacity-40" disabled={blocked || running || busy} onClick={() => { if (!checked.ok) editor.trySubmit(base, source); else onRun(); }}>{running ? <SpinnerIcon /> : <PlayIcon />}{running ? "실행 중" : "실행"}</button>
      <span className="text-xs text-text-3">{blocked ? "자료 상태를 확인한 뒤 실행하세요" : "저장 전에도 실행할 수 있습니다"}</span>
      <span className="flex-1" />{resultActions}
    </div>
    {session.tried && !checked.ok && <p role="alert" className="px-3 pb-2 text-xs text-danger">{checked.errors.list ?? "조건식의 잘못된 값을 고쳐 주세요"}</p>}
    {session.saving.kind === "failed" && <p role="alert" className="px-3 pb-2 text-xs text-danger">{session.saving.message}</p>}
  </section>;
}
