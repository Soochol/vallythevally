import { type RefObject, useId, useLayoutEffect, useRef } from "react";
import { useLayoutStore } from "../../stores/layout";
import { usePersistStore } from "../../stores/persist";
import { DialogFrame, Errors } from "../dialog/DialogParts";
import { ChevronIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { layoutCommands, useLayoutsStore } from "./controller";
import { acknowledgeLayoutMenuFocus, layoutMenu, type LayoutNaming, useLayoutMenuPresentation } from "./presentation";

export function LayoutMenu() {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const { surface, focus } = useLayoutMenuPresentation();
  const layout = useLayoutStore((s) => s.layout);
  const canUndo = useLayoutStore((s) => s.steps.length > 0);
  const offline = usePersistStore((s) => s.phase.kind !== "ready");
  const { phase, layouts } = useLayoutsStore();
  const busy = phase === "busy";
  useLayoutEffect(() => {
    if (!focus || busy || offline) return;
    const target = focus.target === "trigger" ? trigger.current : nameInput.current;
    if (!target?.isConnected || target.disabled) return;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) acknowledgeLayoutMenuFocus(focus.revision);
  }, [focus, busy, offline]);
  const items: MenuItem[] = [
    ...layouts.map((entry): MenuItem => ({ kind: "radio", label: entry.name, value: entry.id, checked: entry.id === layout.id, onSelect: () => { void layoutMenu.select(entry.id); } })),
    { kind: "separator" },
    { kind: "action", label: "새 이름으로 저장…", onSelect: () => layoutMenu.startNaming("saveAs") },
    { kind: "action", label: "이름 바꾸기…", onSelect: () => layoutMenu.startNaming("rename") },
    { kind: "action", label: "지우기", disabled: layouts.length <= 1, danger: true, onSelect: () => { void layoutMenu.confirmDelete(); } },
    { kind: "separator" },
    { kind: "check", label: "십자선 연동", checked: layout.sync.crosshair, onSelect: () => useLayoutStore.getState().setCrosshairSync(!layout.sync.crosshair) },
    { kind: "action", label: "기본 배치로", onSelect: layoutCommands.resetPlacement },
    { kind: "action", label: "배치 되돌리기", disabled: !canUndo, onSelect: () => useLayoutStore.getState().undoArrangement() },
  ];
  return (
    <div ref={root} className="contents">
      <button ref={trigger} data-layout-trigger="" type="button" className="tb-btn max-w-[104px] max-lg:max-w-14 aria-expanded:bg-accent-soft aria-expanded:text-accent" aria-label={`레이아웃: ${layout.name}`} title={`레이아웃: ${layout.name}`} aria-haspopup="menu" aria-expanded={surface.kind === "menu"} disabled={offline || busy} onClick={() => { void layoutMenu.toggle(); }}><span className="truncate">{layout.name}</span><ChevronIcon /></button>
      {surface.kind === "menu" && !busy && <Menu label="레이아웃" root={root} items={items} onClose={layoutMenu.dismissMenu} />}
      {surface.kind === "naming" && <NameDialog naming={surface} input={nameInput} />}
    </div>
  );
}

function NameDialog({ naming: { operation, value, error }, input }: { naming: LayoutNaming; input: RefObject<HTMLInputElement | null> }) {
  const busy = useLayoutsStore((s) => s.phase === "busy");
  const id = useId();
  const title = operation === "saveAs" ? "새 이름으로 저장" : "이름 바꾸기";
  return (
    <DialogFrame labelledBy={`${id}-title`} width="w-[360px]" onClose={layoutMenu.closeNaming}>
      <form className="flex flex-col" onSubmit={(event) => {
        event.preventDefault();
        void layoutMenu.submitName();
      }}>
        <header className="ui-dialog-head"><h2 id={`${id}-title`}>{title}</h2></header>
        <div className="flex flex-col gap-3 p-6">
          <label htmlFor={`${id}-name`}>레이아웃 이름</label>
          <input ref={input} id={`${id}-name`} autoFocus value={value} disabled={busy} aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined} className="ui-field" onChange={(event) => layoutMenu.changeName(event.target.value)} />
          <Errors id={`${id}-error`} messages={error ? [error] : []} />
        </div>
        <footer className="ui-dialog-foot justify-end"><button type="button" className="tb-btn" disabled={busy} onClick={layoutMenu.closeNaming}>취소</button><button type="submit" className="btn-primary" disabled={busy}>저장</button></footer>
      </form>
    </DialogFrame>
  );
}
