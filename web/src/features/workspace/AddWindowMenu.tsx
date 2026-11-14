import { useRef, useState } from "react";
import { WINDOW_KIND_LIST, WINDOW_KINDS, type WindowKind } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { PlusIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { addWindow, CHART_LIMIT_REASON, workspaceRoom } from "./manage";

function kindItem(kind: WindowKind, count: number): MenuItem {
  const { name, maxCount } = WINDOW_KINDS[kind];
  const onSelect = () => addWindow(kind, workspaceRoom());
  if (maxCount > 1) {
    const full = count >= maxCount;
    return { kind: "action", label: name, disabled: full, hint: full ? CHART_LIMIT_REASON : `${count}/${maxCount}`, onSelect };
  }
  return { kind: "action", label: name, hint: count > 0 ? "열려 있음" : undefined, onSelect };
}

export function AddWindowMenu() {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const windows = useLayoutStore((s) => s.layout.windows);
  const items = WINDOW_KIND_LIST.map((kind) => kindItem(kind, windows.filter((w) => w.kind === kind).length));
  return (
    <div ref={root} className="contents">
      <button type="button" className="tb-btn aria-expanded:bg-accent-soft aria-expanded:font-semibold aria-expanded:text-accent" aria-haspopup="menu" aria-expanded={open} title="창 더하기" onClick={() => setOpen((now) => !now)}><PlusIcon />창 더하기</button>
      {open && <Menu label="창 더하기" root={root} items={items} onClose={() => setOpen(false)} />}
    </div>
  );
}
