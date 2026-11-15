import { useId, useRef, useState } from "react";
import { useLayoutStore } from "../../stores/layout";
import { usePersistStore } from "../../stores/persist";
import { DialogFrame, Errors } from "../dialog/DialogParts";
import { ChevronIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { confirmAction } from "../overlay/Confirm";
import { layoutCommands, layoutNameProblem, showLayoutError, useLayoutsStore } from "./controller";

type Naming = "saveAs" | "rename";

export function LayoutMenu() {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<Naming | null>(null);
  const layout = useLayoutStore((s) => s.layout);
  const canUndo = useLayoutStore((s) => s.steps.length > 0);
  const offline = usePersistStore((s) => s.phase.kind !== "ready");
  const { phase, layouts } = useLayoutsStore();
  const busy = phase === "busy";
  const items: MenuItem[] = [
    ...layouts.map((entry): MenuItem => ({ kind: "radio", label: entry.name, value: entry.id, checked: entry.id === layout.id, onSelect: () => { void layoutCommands.open(entry.id).catch(showLayoutError); } })),
    { kind: "separator" },
    { kind: "action", label: "새 이름으로 저장…", onSelect: () => setNaming("saveAs") },
    { kind: "action", label: "이름 바꾸기…", onSelect: () => setNaming("rename") },
    { kind: "action", label: "지우기", disabled: layouts.length <= 1, danger: true, onSelect: () => {
      void confirmAction(`${layout.name} 레이아웃을 지웁니다`, { action: "레이아웃 지우기", danger: true }).then((confirmed) => confirmed ? layoutCommands.delete() : undefined).catch(showLayoutError);
    } },
    { kind: "separator" },
    { kind: "action", label: "기본 배치로", onSelect: layoutCommands.resetPlacement },
    { kind: "action", label: "배치 되돌리기", disabled: !canUndo, onSelect: () => useLayoutStore.getState().undoArrangement() },
  ];
  return (
    <div ref={root} className="contents">
      <button type="button" className="tb-btn max-w-[104px] max-lg:max-w-14 aria-expanded:bg-accent-soft aria-expanded:text-accent" aria-label={`레이아웃: ${layout.name}`} title={`레이아웃: ${layout.name}`} aria-haspopup="menu" aria-expanded={open} disabled={offline || busy} onClick={() => {
        if (open) { setOpen(false); return; }
        void layoutCommands.refresh().then(() => setOpen(true)).catch(showLayoutError);
      }}><span className="truncate">{layout.name}</span><ChevronIcon /></button>
      {open && !busy && <Menu label="레이아웃" root={root} items={items} onClose={() => setOpen(false)} />}
      {naming && <NameDialog kind={naming} onClose={() => setNaming(null)} />}
    </div>
  );
}

function NameDialog({ kind, onClose }: { kind: Naming; onClose(): void }) {
  const layout = useLayoutStore((s) => s.layout);
  const layouts = useLayoutsStore((s) => s.layouts);
  const busy = useLayoutsStore((s) => s.phase === "busy");
  const [value, setValue] = useState(kind === "rename" ? layout.name : "");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const title = kind === "saveAs" ? "새 이름으로 저장" : "이름 바꾸기";
  const close = () => { if (!busy) onClose(); };
  return (
    <DialogFrame labelledBy={`${id}-title`} width="w-[360px]" onClose={close}>
      <form className="flex flex-col" onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const problem = layoutNameProblem(value, layouts, kind === "rename" ? layout.id : undefined);
        if (problem) { setError(problem); return; }
        void layoutCommands[kind](value).then(onClose).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
      }}>
        <header className="ui-dialog-head"><h2 id={`${id}-title`}>{title}</h2></header>
        <div className="flex flex-col gap-3 p-6">
          <label htmlFor={`${id}-name`}>레이아웃 이름</label>
          <input id={`${id}-name`} autoFocus value={value} disabled={busy} aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined} className="ui-field" onChange={(event) => { setValue(event.target.value); setError(null); }} />
          <Errors id={`${id}-error`} messages={error ? [error] : []} />
        </div>
        <footer className="ui-dialog-foot justify-end"><button type="button" className="tb-btn" disabled={busy} onClick={close}>취소</button><button type="submit" className="btn-primary" disabled={busy}>저장</button></footer>
      </form>
    </DialogFrame>
  );
}
