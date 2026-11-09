import type { SymbolCode } from "../../api/generated/SymbolCode";
import { isPeriod } from "../../lib/symbol";
import { RETRY_DELAYS_MS } from "../../persist/saver";
import { type DrawingBody, type DrawingId, type DrawingOp, type DrawingPoint, type DrawingScope, isDrawingTool, TOOL_POINTS } from "./types";

export type Want = { kind: "put"; body: DrawingBody; reserved?: true } | { kind: "delete" };

export interface Intent {
  readonly v: 2;
  readonly id: DrawingId;
  readonly symbol: SymbolCode;
  readonly uuid: string;
  readonly order: number;
  readonly want: Want;
  readonly lastRevision: number;
}

export type Lane =
  | { readonly state: "waiting"; readonly intent: Intent; readonly failures: number; readonly retryAt: number }
  | { readonly state: "flying"; readonly sent: Intent; readonly next: Intent | null; readonly failures: number };

export interface Outbox { readonly lanes: ReadonlyMap<DrawingId, Lane> }
export const EMPTY_OUTBOX: Outbox = { lanes: new Map() };

export type Outcome =
  | { kind: "ok" }
  | { kind: "stale" }
  | { kind: "clientError"; tooLarge: boolean }
  | { kind: "networkError" };

export function wantOf(op: DrawingOp): Want {
  return op.kind === "delete" ? { kind: "delete" } : { kind: "put", body: op.after };
}

function withLane(o: Outbox, id: DrawingId, lane: Lane): Outbox {
  return { lanes: new Map(o.lanes).set(id, lane) };
}

export function drop(o: Outbox, id: DrawingId): Outbox {
  const lanes = new Map(o.lanes);
  lanes.delete(id);
  return { lanes };
}

export function enqueue(o: Outbox, intent: Intent): Outbox {
  const lane = o.lanes.get(intent.id);
  if (lane?.state === "flying") return withLane(o, intent.id, { ...lane, next: intent });
  return withLane(o, intent.id, { state: "waiting", intent, failures: 0, retryAt: 0 });
}

export function nextToSend(o: Outbox, now: number): DrawingId[] {
  return [...o.lanes].filter(([, l]) => l.state === "waiting" && l.retryAt <= now).map(([id]) => id);
}

export function start(o: Outbox, id: DrawingId): { outbox: Outbox; send: Intent } | null {
  const lane = o.lanes.get(id);
  if (lane?.state !== "waiting") return null;
  return { outbox: withLane(o, id, { state: "flying", sent: lane.intent, next: null, failures: lane.failures }), send: lane.intent };
}

export type Settled =
  | { kind: "acked"; sent: Intent }
  | { kind: "stale" }
  | { kind: "rejected"; tooLarge: boolean }
  | { kind: "retrying"; at: number }
  | { kind: "failed" };

export function settle(o: Outbox, id: DrawingId, outcome: Outcome, now: number): { outbox: Outbox; settled: Settled } | null {
  const lane = o.lanes.get(id);
  if (lane?.state !== "flying") return null;
  const waiting = (intent: Intent, failures: number, retryAt: number): Outbox =>
    withLane(o, id, { state: "waiting", intent, failures, retryAt });
  const done = (settled: Settled) => ({ outbox: lane.next === null ? drop(o, id) : waiting(lane.next, 0, 0), settled });
  switch (outcome.kind) {
    case "ok": return done({ kind: "acked", sent: lane.sent });
    case "stale": return done({ kind: "stale" });
    case "clientError": return done({ kind: "rejected", tooLarge: outcome.tooLarge });
    case "networkError": {
      const failures = lane.failures + 1;
      const delay = RETRY_DELAYS_MS[failures - 1];
      const at = delay === undefined ? Infinity : now + delay;
      return { outbox: waiting(lane.next ?? lane.sent, failures, at), settled: delay === undefined ? { kind: "failed" } : { kind: "retrying", at } };
    }
  }
}

export function retryFailed(o: Outbox): Outbox {
  let out = o;
  for (const [id, lane] of o.lanes)
    if (lane.state === "waiting" && lane.retryAt === Infinity) out = withLane(out, id, { ...lane, failures: 0, retryAt: 0 });
  return out;
}
export function pause(o: Outbox, id: DrawingId): Outbox {
  const lane = o.lanes.get(id);
  return lane?.state === "waiting" ? withLane(o, id, { ...lane, retryAt: Infinity }) : o;
}
export const isFailed = (lane: Lane): boolean => lane.state === "waiting" && lane.retryAt === Infinity;
export function latestIntent(lane: Lane): Intent { return lane.state === "waiting" ? lane.intent : (lane.next ?? lane.sent); }
export function latestWant(lane: Lane): Want { return latestIntent(lane).want; }
export function flushable(o: Outbox): DrawingId[] { return [...o.lanes].filter(([, l]) => l.state === "waiting").map(([id]) => id); }

export const UNSAVED_PREFIX = "vv.unsaved.drawing.";
export const recordKey = (id: DrawingId) => `${UNSAVED_PREFIX}${id}`;
export interface LaneRecord { v: 1; id: DrawingId; symbol: SymbolCode; want: Want; lastRevision: number }

type Fields = Record<string, unknown>;

function fields(raw: unknown): Fields | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw)) : null;
}

const isRevision = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

function parsePoint(raw: unknown): DrawingPoint | null {
  const f = fields(raw);
  if (f === null) return null;
  const { t, price } = f;
  return typeof t === "number" && Number.isSafeInteger(t) && typeof price === "number" && Number.isFinite(price) ? { t, price } : null;
}

function parseScope(raw: unknown): DrawingScope | null {
  const f = fields(raw);
  if (f === null) return null;
  const { kind, layoutId, slot } = f;
  if (kind === "symbol") return { kind };
  if (typeof layoutId !== "string") return null;
  if (kind === "layout") return { kind, layoutId };
  if (kind === "cell" && (slot === 0 || slot === 1 || slot === 2 || slot === 3)) return { kind, layoutId, slot };
  return null;
}

export function parseDrawingBody(raw: unknown): DrawingBody | null {
  const f = fields(raw);
  if (f === null) return null;
  const { id, symbol, tool, text, style, locked, hidden, z, group, revision } = f;
  if (typeof id !== "string" || typeof symbol !== "string" || typeof tool !== "string" || !isDrawingTool(tool)) return null;
  if (!Array.isArray(f.points)) return null;
  const points = f.points.map(parsePoint).filter((p) => p !== null);
  const count = TOOL_POINTS[tool];
  const countOk = count.kind === "exact" ? points.length === count.n : points.length >= count.min && points.length <= count.max;
  if (points.length !== f.points.length || !countOk) return null;
  let periods: DrawingBody["periods"] = null;
  if (f.periods !== null) {
    if (!Array.isArray(f.periods) || f.periods.length === 0) return null;
    const valid = f.periods.filter((p) => typeof p === "string" && isPeriod(p));
    if (valid.length !== f.periods.length) return null;
    periods = valid;
  }
  const scope = parseScope(f.scope);
  if (text !== null && typeof text !== "string") return null;
  if (typeof locked !== "boolean" || typeof hidden !== "boolean") return null;
  if (typeof z !== "number" || !Number.isFinite(z) || (group !== null && typeof group !== "string")) return null;
  if (scope === null || !isRevision(revision) || style === undefined) return null;
  return { id, symbol, tool, points, text, style, locked, hidden, periods, z, group, scope, revision };
}

function parseWant(raw: unknown): Want | null {
  const f = fields(raw);
  if (f?.kind === "delete") return { kind: "delete" };
  if (f?.kind !== "put") return null;
  const body = parseDrawingBody(f.body);
  return body === null ? null : { kind: "put", body, ...(f.reserved === true ? { reserved: true } : {}) };
}

export function parseRecord(raw: unknown): LaneRecord | null {
  const f = fields(raw);
  if (f === null || f.v !== 1 || typeof f.id !== "string" || typeof f.symbol !== "string" || !isRevision(f.lastRevision)) return null;
  const want = parseWant(f.want);
  if (want === null || (want.kind === "put" && (want.body.id !== f.id || want.body.symbol !== f.symbol))) return null;
  return { v: 1, id: f.id, symbol: f.symbol, want, lastRevision: f.lastRevision };
}
