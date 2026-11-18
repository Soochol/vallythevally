import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { listGroups } from "../../layout/dock/tree";
import type { DockPlacement } from "../../layout/placement";
import { useLayoutStore } from "../../stores/layout";

export function useDockMaximize({ dock, enabled, dragging }: { dock: DockPlacement; enabled: boolean; dragging: boolean }) {
  const [requested, setRequested] = useState<string | null>(null);
  const session = useLayoutStore((s) => s.session);
  const maximized = enabled && requested !== null && listGroups(dock.root).some((group) => group.id === requested) ? requested : null;
  const end = useCallback(() => setRequested(null), []);
  const toggle = useCallback((group: string) => setRequested((now) => (now === group ? null : group)), []);

  useLayoutEffect(() => { if (maximized === null) setRequested(null); }, [maximized]);
  useLayoutEffect(() => { setRequested(null); }, [session]);
  useLayoutEffect(() => { if (dragging) setRequested(null); }, [dragging]);
  useEffect(() => {
    if (maximized === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest("[role=menu],[role=dialog]")) return;
      event.preventDefault();
      setRequested(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [maximized]);

  return { maximized, toggle, end };
}
