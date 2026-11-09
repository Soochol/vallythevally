import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ApiRequestError, deleteJson, getJson, putJson } from "../../api/http";
import type { SaveState } from "../../persist/saver";
import { usePersistStore } from "../../stores/persist";
import { useSelectionStore } from "../../stores/selection";
import { EMPTY_HISTORY, planRedo, planUndo, record, sameContent, type History } from "./history";
import * as queue from "./outbox";
import { opId, type Drawing, type DrawingBody, type DrawingOp } from "./types";

const key = (symbol: string) => ["drawings", symbol] as const;
export const drawingPath = (id: string) => `/api/drawings/${encodeURIComponent(id)}`;
const toast = (text: string) => useSelectionStore.getState().showToast(text);

export class DrawingSync {
  private outbox: queue.Outbox = queue.EMPTY_OUTBOX;
  private histories = new Map<number, History>();
  private listeners = new Set<() => void>();
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private symbols = new Set<string>();
  private loads = new Map<string, Promise<unknown>>();
  private errors = new Map<string, string>();
  save: SaveState = { kind: "idle" };

  constructor(private client: QueryClient) {
    const records: queue.LaneRecord[] = [];
    try {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith(queue.UNSAVED_PREFIX)) continue;
        try { const parsed = queue.parseRecord(JSON.parse(localStorage.getItem(k) ?? "null")); if (parsed) records.push(parsed); } catch { continue; }
      }
    } catch { toast("복구 저장소를 쓸 수 없습니다. 이 탭을 닫기 전에 저장 상태를 확인하세요"); }
    this.outbox = queue.restore(records);
    this.client.getQueryCache().subscribe((e) => { if (e.query.queryKey[0] === "drawings") this.emit(); });
    window.addEventListener("focus", () => this.refresh());
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" ? this.refresh() : this.flush());
    window.addEventListener("pagehide", () => this.flush());
    if (records.length) this.pump();
  }

  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  snapshot = () => this.version;
  private emit() { this.version++; this.listeners.forEach((f) => f()); }
  loadError(symbol: string) { return this.errors.get(symbol) ?? null; }

  load(symbol: string): Promise<unknown> {
    this.symbols.add(symbol);
    const loading = this.loads.get(symbol);
    if (loading) return loading;
    const task = this.client.fetchQuery({ queryKey: key(symbol), queryFn: ({ signal }) => getJson<Drawing[]>(`/api/drawings?symbol=${encodeURIComponent(symbol)}`, signal), staleTime: 0, retry: false })
      .then(() => { this.errors.delete(symbol); })
      .catch((e: unknown) => { this.errors.set(symbol, e instanceof Error ? e.message : "드로잉을 불러오지 못했습니다"); })
      .finally(() => { this.loads.delete(symbol); this.emit(); });
    this.loads.set(symbol, task);
    return task;
  }

  refresh() { for (const symbol of this.symbols) void this.load(symbol); }
  dataChanged() { this.refresh(); }

  drawings(symbol: string): DrawingBody[] {
    const merged = new Map<string, DrawingBody>((this.client.getQueryData<Drawing[]>(key(symbol)) ?? []).map((d) => [d.id, d]));
    for (const lane of this.outbox.lanes.values()) {
      if (lane.symbol !== symbol) continue;
      const want = queue.latestWant(lane);
      if (want.kind === "delete") merged.delete(lane.id); else merged.set(lane.id, want.body);
    }
    return [...merged.values()].sort((a, b) => a.z - b.z);
  }

  history(slot: number) { return this.histories.get(slot) ?? EMPTY_HISTORY; }
  commit(slot: number, ops: readonly DrawingOp[], addHistory = true) {
    if (usePersistStore.getState().phase.kind !== "ready") { toast("서버 연결을 복구한 뒤 드로잉을 편집하세요"); return; }
    const changed = ops.filter((op) => op.kind !== "update" || !sameContent(op.before, op.after));
    if (!changed.length) return;
    if (addHistory) this.histories.set(slot, record(this.history(slot), changed));
    let next = this.outbox;
    for (const op of changed) {
      const body = op.kind === "delete" ? op.before : op.after;
      next = queue.reserve(next, { id: opId(op), symbol: body.symbol, want: queue.wantOf(op) }, Date.now);
    }
    this.changeOutbox(next);
    this.save = { kind: "pending" };
    this.emit(); this.pump();
  }

  undo(slot: number, redo = false) {
    const current = (id: string) => {
      for (const symbol of this.symbols) { const d = this.drawings(symbol).find((item) => item.id === id); if (d) return d; }
      return null;
    };
    const plan = (redo ? planRedo : planUndo)(this.history(slot), current);
    if (plan.kind === "nothing") return;
    this.histories.set(slot, plan.history);
    if (plan.kind === "conflict") toast("다른 곳에서 바뀐 드로잉이라 되돌리지 않았습니다");
    else this.commit(slot, plan.ops, false);
    this.emit();
  }

  retry() { this.changeOutbox(queue.retryFailed(this.outbox)); this.pump(); }
  private flush() { for (const id of queue.flushable(this.outbox)) this.send(id, true); }

  private changeOutbox(next: queue.Outbox) {
    const changes = queue.recordChanges(this.outbox, next);
    try {
      for (const r of changes.write) localStorage.setItem(queue.recordKey(r.id), JSON.stringify(r));
      for (const id of changes.remove) localStorage.removeItem(queue.recordKey(id));
    } catch { toast("복구 저장소를 쓸 수 없습니다. 이 탭을 닫기 전에 저장 상태를 확인하세요"); }
    this.outbox = next;
  }

  private pump() {
    if (this.timer !== null) clearTimeout(this.timer);
    for (const id of queue.nextToSend(this.outbox, Date.now())) this.send(id, false);
    const waiting = [...this.outbox.lanes.values()].flatMap((l) => l.state === "waiting" && Number.isFinite(l.retryAt) ? [l.retryAt] : []);
    if (waiting.length) this.timer = setTimeout(() => this.pump(), Math.max(0, Math.min(...waiting) - Date.now()));
  }

  private send(id: string, keepalive: boolean) {
    const started = queue.start(this.outbox, id, Date.now);
    if (!started) return;
    this.changeOutbox(started.outbox);
    this.save = { kind: "saving" }; this.emit();
    const { want, symbol } = started.send;
    const sending = want.kind === "delete" ? deleteJson(drawingPath(id), { keepalive }) : putJson<Drawing>(drawingPath(id), want.body, { keepalive });
    void sending.then((saved) => {
      this.client.setQueryData<Drawing[]>(key(symbol), (old = []) => [...old.filter((d) => d.id !== id), ...(saved ? [saved] : [])]);
      this.settle(id, { kind: "ok" });
    }).catch((e: unknown) => {
      const outcome: queue.Outcome = e instanceof ApiRequestError && e.code === "stale_revision" ? { kind: "stale" }
        : e instanceof ApiRequestError && (e.code === "bad_request" || e.code === "payload_too_large" || e.code === "not_found") ? { kind: "clientError", tooLarge: e.code === "payload_too_large" }
        : { kind: "networkError" };
      this.settle(id, outcome);
      if (outcome.kind === "stale" || outcome.kind === "clientError") { void this.load(symbol); toast(outcome.kind === "stale" ? "다른 곳의 새 수정이 있어 드로잉을 다시 불러왔습니다" : "드로잉을 저장하지 못했습니다"); }
    });
  }

  private settle(id: string, outcome: queue.Outcome) {
    const settled = queue.settle(this.outbox, id, outcome, Date.now());
    if (!settled) return;
    this.changeOutbox(settled.outbox);
    if (settled.settled.kind === "rejected") this.save = settled.settled.tooLarge ? { kind: "failed", reason: "too_large" } : { kind: "failed", reason: "error", message: "드로잉 저장 실패" };
    else if ([...this.outbox.lanes.values()].some(queue.isFailed)) this.save = { kind: "failed", reason: "error", message: "드로잉 저장 실패" };
    else this.save = this.outbox.lanes.size ? { kind: "pending" } : { kind: "saved", at: Date.now() };
    this.emit(); this.pump();
  }
}

const services = new WeakMap<QueryClient, DrawingSync>();
export function drawingSync(client: QueryClient): DrawingSync {
  let sync = services.get(client);
  if (!sync) { sync = new DrawingSync(client); services.set(client, sync); }
  return sync;
}
export function useDrawingVersion(sync: DrawingSync) { return useSyncExternalStore(sync.subscribe, sync.snapshot); }
