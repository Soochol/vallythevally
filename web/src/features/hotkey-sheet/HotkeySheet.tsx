import { Fragment, useId, useState } from "react";
import { useSelectionStore } from "../../stores/selection";
import { useActionKeys } from "../../stores/ui";
import { DialogFrame } from "../dialog/DialogParts";
import { CloseIcon, SearchIcon } from "../icons";
import { EmptyState } from "../overlay/State";
import { Kbd } from "../ui/Kbd";
import { keyParts, sheetSections, type SheetRow } from "./sheetRows";

export function HotkeySheet() {
  const shown = useSelectionStore((s) => s.dialog?.kind === "hotkey-sheet");
  return shown ? <HotkeySheetBody /> : null;
}

function HotkeySheetBody() {
  const close = useSelectionStore((s) => s.closeDialog);
  const openSystemSettings = useSelectionStore((s) => s.openSystemSettings);
  const keys = useActionKeys();
  const [query, setQuery] = useState("");
  const titleId = useId();
  const sections = sheetSections(keys, query);
  return <DialogFrame solid labelledBy={titleId} onClose={close} width="h-[min(640px,80dvh)] w-[min(720px,calc(100vw-32px))] max-md:h-[85dvh]">
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-3 border-b border-line px-4 py-3 focus-within:border-accent">
        <h2 id={titleId} className="text-l font-semibold">단축키</h2>
        <label className="flex min-w-0 flex-1 items-center gap-2 text-text-3">
          <SearchIcon size={16} />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="동작이나 키로 찾기" aria-label="단축키 찾기" autoComplete="off" spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-s text-text outline-none placeholder:text-text-3" />
        </label>
        <button type="button" className="btn" onClick={() => openSystemSettings("hotkeys")}>바꾸기</button>
        <button type="button" aria-label="단축키 판 닫기" title="닫기 (Esc)" className="icon-btn" onClick={close}><CloseIcon /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {sections.length === 0 ? <EmptyState title="맞는 단축키가 없습니다">동작 이름이나 키로 다시 찾아 보세요.</EmptyState> : sections.map((section) => <section key={section.group} aria-label={section.label}>
          <h3 className="px-3 pb-1 pt-4 text-xs text-text-3">{section.label}</h3>
          <ul>{section.rows.map((row) => <SheetLine key={row.id} row={row} />)}</ul>
        </section>)}
      </div>
    </div>
  </DialogFrame>;
}

function SheetLine({ row }: { row: SheetRow }) {
  return <li className="grid min-h-[32px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-m px-3 py-1 text-s hover:bg-hover">
    <span className="min-w-0 truncate text-text">{row.name}</span>
    <span className="flex flex-wrap items-center justify-end gap-1 text-text-3">
      {row.labels.map((label, i) => <Fragment key={label}>
        {i > 0 && <span className="text-xs">또는</span>}
        <span className="flex items-center gap-0.5">{keyParts(label).map((part, j) => <Kbd key={j}>{part}</Kbd>)}</span>
      </Fragment>)}
    </span>
  </li>;
}
