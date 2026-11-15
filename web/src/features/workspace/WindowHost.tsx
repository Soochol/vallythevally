import { type RefObject, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { GroupNode } from "../../layout/dock/tree";
import type { WindowState } from "../../stores/layout";
import { WINDOW_CONTENT } from "./contents";

export function WindowHost({ window, group, parking }: { window: WindowState; group: GroupNode | null; parking: RefObject<HTMLDivElement | null> }) {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "dock-window-host";
    return element;
  });
  const active = group?.active === window.id;
  useLayoutEffect(() => {
    const destination = active && group ? document.getElementById(`window-panel-${group.id}`) : parking.current;
    if (destination && host.parentElement !== destination) destination.appendChild(host);
  });
  useLayoutEffect(() => () => host.remove(), [host]);
  const { Content } = WINDOW_CONTENT[window.kind];
  return createPortal(window.kind === "chart" || active ? <Content id={window.id} /> : null, host, window.id);
}
