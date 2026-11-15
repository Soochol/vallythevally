import { findGroup } from "../layout/dock/tree";
import type { DockOrigins } from "../layout/dock/floats";
import type { WindowId } from "../layout/kinds";
import type { EditableLayout } from "../stores/layout";

type OriginHints = { v: 1; document: string; origins: [WindowId, string][] };
export const dockOriginsKey = (layout: string) => `vv.dock-origins.${layout}`;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]));
  return value;
}

const fingerprint = (layout: EditableLayout) => JSON.stringify(canonical(layout));
const isEntry = (value: unknown): value is [string, string] => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string";

export function readDockOrigins(layout: EditableLayout): DockOrigins {
  const origins = new Map<WindowId, string>();
  try {
    const raw = globalThis.localStorage?.getItem(dockOriginsKey(layout.id));
    if (!raw) return origins;
    const hints: unknown = JSON.parse(raw);
    if (typeof hints !== "object" || hints === null || !("v" in hints) || hints.v !== 1 || !("document" in hints) || hints.document !== fingerprint(layout) || !("origins" in hints) || !Array.isArray(hints.origins)) return origins;
    const entries: unknown[] = hints.origins;
    if (!entries.every(isEntry)) return origins;
    const dock = layout.placement.dock;
    if (!dock) return origins;
    for (const [window, group] of entries) {
      const id = layout.windows.find((candidate) => candidate.id === window)?.id;
      if (!id || origins.has(id) || !dock.floats.some((float) => float.window === id) || !findGroup(dock.root, group)) return new Map();
      origins.set(id, group);
    }
  } catch { return new Map(); }
  return origins;
}

export function writeDockOrigins(layout: EditableLayout, origins: DockOrigins): void {
  try {
    const key = dockOriginsKey(layout.id);
    if (origins.size === 0) { globalThis.localStorage?.removeItem(key); return; }
    const hints: OriginHints = { v: 1, document: fingerprint(layout), origins: [...origins] };
    globalThis.localStorage?.setItem(key, JSON.stringify(hints));
  } catch { return; }
}
