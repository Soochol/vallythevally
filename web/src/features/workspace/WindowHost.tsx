import { type RefObject, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { WindowState } from "../../stores/layout";
import { PUBLIC_UNAVAILABLE_KINDS, PublicUnavailable } from "../../public-mode/PublicUnavailable";
import { usePublicMode } from "../../public-mode/serverMode";
import { WINDOW_CONTENT } from "./contents";
import { useWindowVisible, WindowVisibleProvider } from "./windowVisibility";

export function WindowHost({ window, panel, parking }: { window: WindowState; panel: string | null; parking: RefObject<HTMLDivElement | null> }) {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "dock-window-host";
    return element;
  });
  const workspaceVisible = useWindowVisible();
  const active = panel !== null;
  const visible = workspaceVisible && active;
  useLayoutEffect(() => {
    const destination = (panel && document.getElementById(panel)) || parking.current;
    if (destination && host.parentElement !== destination) destination.appendChild(host);
  });
  useLayoutEffect(() => () => host.remove(), [host]);
  const publicMode = usePublicMode();
  const { Content } = publicMode && PUBLIC_UNAVAILABLE_KINDS.has(window.kind) ? { Content: PublicUnavailable } : WINDOW_CONTENT[window.kind];
  return createPortal(
    window.kind === "chart" || active ? (
      <WindowVisibleProvider value={visible}>
        <Content id={window.id} />
      </WindowVisibleProvider>
    ) : null,
    host,
    window.id,
  );
}
