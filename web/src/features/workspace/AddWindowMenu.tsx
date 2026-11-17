import { useRef, useState } from "react";
import { MAX_WINDOWS, WINDOW_KIND_LIST, WINDOW_KINDS, type WindowKind } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { PlusIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { addWindow, CHART_LIMIT_REASON, WINDOW_LIMIT_REASON, workspaceRoom } from "./manage";
import { focusWithoutActivation } from "./focus";

function kindItem(kind: WindowKind, count: number, windowCount: number, targetGroup?: string): MenuItem {
  const { name, maxCount } = WINDOW_KINDS[kind];
  const onSelect = () => {
    const id = addWindow(kind, workspaceRoom(), targetGroup);
    if (targetGroup && id) requestAnimationFrame(() => focusWithoutActivation(document.getElementById(`window-tab-${id}`)));
  };
  if (maxCount > 1) {
    const full = count >= maxCount || windowCount >= MAX_WINDOWS;
    return { kind: "action", label: name, disabled: full, hint: count >= maxCount ? CHART_LIMIT_REASON : windowCount >= MAX_WINDOWS ? WINDOW_LIMIT_REASON : `${count}/${maxCount}`, onSelect };
  }
  if (count === 0 && windowCount >= MAX_WINDOWS) return { kind: "action", label: name, disabled: true, hint: WINDOW_LIMIT_REASON, onSelect };
  return { kind: "action", label: name, hint: count > 0 ? "열려 있음" : undefined, onSelect };
}

export function AddWindowMenu({ targetGroup }: { targetGroup?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const windows = useLayoutStore((s) => s.layout.windows);
  const items = WINDOW_KIND_LIST.map((kind) => kindItem(kind, windows.filter((w) => w.kind === kind).length, windows.length, targetGroup));
  return (
    <div ref={root} className="contents">
      <button type="button" className={`${targetGroup ? "dock-add" : "tb-btn"} aria-expanded:bg-accent-soft aria-expanded:font-semibold aria-expanded:text-accent`} aria-label={targetGroup ? "이 묶음에 창 더하기" : "창 더하기"} aria-haspopup="menu" aria-expanded={open} title="창 더하기" onClick={() => setOpen((now) => !now)}><PlusIcon />{!targetGroup && <span className="max-xl:hidden">창 더하기</span>}</button>
      {open && <Menu label="창 더하기" root={root} items={items} onClose={() => setOpen(false)} />}
    </div>
  );
}
