import { type DrawingBody, type DrawingId, type DrawingOp, opId } from "./types";

export const HISTORY_LIMIT = 100;

export type HistoryEntry = readonly [DrawingOp, ...DrawingOp[]];

export interface History {
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
}

export const EMPTY_HISTORY: History = { past: [], future: [] };

const VERSION_KEYS: ReadonlySet<string> = new Set(["revision", "updatedAt"]);

function canonical(value: unknown, skip: ReadonlySet<string> = new Set()): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([k, v]) => !skip.has(k) && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function sameContent(a: DrawingBody | null, b: DrawingBody | null): boolean {
  if (a === null || b === null) return a === b;
  return canonical(a, VERSION_KEYS) === canonical(b, VERSION_KEYS);
}

function opOf(before: DrawingBody | null, after: DrawingBody | null): DrawingOp | null {
  if (before === null) return after === null ? null : { kind: "create", after };
  if (after === null) return { kind: "delete", before };
  return sameContent(before, after) ? null : { kind: "update", before, after };
}

const beforeOf = (op: DrawingOp): DrawingBody | null => (op.kind === "create" ? null : op.before);
const afterOf = (op: DrawingOp): DrawingBody | null => (op.kind === "delete" ? null : op.after);

function entryOf(ops: readonly DrawingOp[]): HistoryEntry | null {
  const spans = new Map<DrawingId, { before: DrawingBody | null; after: DrawingBody | null }>();
  for (const op of ops) {
    const id = opId(op);
    const span = spans.get(id);
    spans.set(id, { before: span === undefined ? beforeOf(op) : span.before, after: afterOf(op) });
  }
  const [first, ...rest] = [...spans.values()].flatMap(({ before, after }) => opOf(before, after) ?? []);
  return first === undefined ? null : [first, ...rest];
}

export function record(h: History, ops: readonly DrawingOp[]): History {
  const entry = entryOf(ops);
  if (entry === null) return h;
  return { past: [...h.past, entry].slice(-HISTORY_LIMIT), future: [] };
}

export function invert(op: DrawingOp): DrawingOp {
  switch (op.kind) {
    case "create":
      return { kind: "delete", before: op.after };
    case "update":
      return { kind: "update", before: op.after, after: op.before };
    case "delete":
      return { kind: "create", after: op.before };
  }
}

export type Current = (id: DrawingId) => DrawingBody | null;

export type Plan =
  | { kind: "nothing" }
  | { kind: "apply"; ops: HistoryEntry; history: History }
  | { kind: "conflict"; ids: readonly DrawingId[]; history: History };

const conflicts = (entry: HistoryEntry, current: Current, expected: (op: DrawingOp) => DrawingBody | null) =>
  entry.filter((op) => !sameContent(current(opId(op)), expected(op))).map(opId);

export function planUndo(h: History, current: Current): Plan {
  const entry = h.past.at(-1);
  if (entry === undefined) return { kind: "nothing" };
  const past = h.past.slice(0, -1);
  const ids = conflicts(entry, current, afterOf);
  if (ids.length > 0) return { kind: "conflict", ids, history: { past, future: h.future } };
  const [first, ...rest] = entry;
  return { kind: "apply", ops: [invert(first), ...rest.map(invert)], history: { past, future: [...h.future, entry] } };
}

export function planRedo(h: History, current: Current): Plan {
  const entry = h.future.at(-1);
  if (entry === undefined) return { kind: "nothing" };
  const future = h.future.slice(0, -1);
  const ids = conflicts(entry, current, beforeOf);
  if (ids.length > 0) return { kind: "conflict", ids, history: { past: h.past, future } };
  return { kind: "apply", ops: entry, history: { past: [...h.past, entry], future } };
}
