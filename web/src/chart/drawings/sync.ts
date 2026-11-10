import { isCancelledError, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { ApiRequestError, deleteJson, getJson, putJson } from "../../api/http";
import type { SaveState } from "../../persist/saver";
import { usePersistStore } from "../../stores/persist";
import { useSelectionStore } from "../../stores/selection";
import { EMPTY_HISTORY, planRedo, planUndo, record, sameContent, type History } from "./history";
import * as queue from "./outbox";
import { compareIntent, DrawingJournal } from "./journal";
import { opId, type Drawing, type DrawingBody, type DrawingOp } from "./types";

const key = (symbol: string) => ["drawings", symbol] as const;
export const drawingPath = (id: string) => `/api/drawings/${encodeURIComponent(id)}`;
const toast = (text: string) => useSelectionStore.getState().showToast(text);
export const useDrawingSave = create<{ state: SaveState; retry(): void }>()(() => ({ state: { kind: "idle" }, retry: () => {} }));

export class DrawingSync {
  private outbox: queue.Outbox = queue.EMPTY_OUTBOX;
  private desired = new Map<string, { intent: queue.Intent; state: "pending" | "admitted" }>();
  private journal: DrawingJournal | null = null;
  private admissions = new Map<string, Promise<void>>();
  private launches = new Set<string>();
  private recoveryIds = new Set<string>();
  private cleanups = new Map<string, queue.Intent>();
  private recoveryError: string | null = null;
  private stageFailed = false;
  private saveFailure: SaveState | null = null;
  private histories = new Map<number, History>();
  private listeners = new Set<() => void>();
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private symbols = new Set<string>();
  private loads = new Map<string, Promise<unknown>>();
  private errors = new Map<string, string>();
  save: SaveState = { kind: "idle" };

  constructor(private client: QueryClient) {
    useDrawingSave.setState({ retry: () => this.retry() });
    try {
      this.journal = new DrawingJournal();
      const snapshot = this.journal.snapshot();
      for (const intent of snapshot.intents) {
        const previous = this.desired.get(intent.id);
        if (!previous || compareIntent(intent, previous.intent) > 0) this.desired.set(intent.id, { intent, state: "pending" });
      }
      for (const id of snapshot.ids) { this.recoveryIds.add(id); this.recover(id); }
    } catch { this.recoveryFailed(); }
    this.client.getQueryCache().subscribe((e) => { if (e.query.queryKey[0] === "drawings") this.emit(); });
    window.addEventListener("focus", () => this.refresh());
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" ? this.refresh() : this.flush());
    window.addEventListener("pagehide", () => this.flush());
    if (this.desired.size || this.recoveryError) this.updateSave();
  }

  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  snapshot = () => this.version;
  private emit() { this.version++; if (useDrawingSave.getState().state !== this.save) useDrawingSave.setState({ state: this.save }); this.listeners.forEach((f) => f()); }
  loadError(symbol: string) { return this.errors.get(symbol) ?? null; }

  load(symbol: string): Promise<unknown> {
    this.symbols.add(symbol);
    const loading = this.loads.get(symbol);
    if (loading) return loading;
    const task = this.client.fetchQuery({ queryKey: key(symbol), queryFn: ({ signal }) => getJson<Drawing[]>(`/api/drawings?symbol=${encodeURIComponent(symbol)}`, signal), staleTime: 0, retry: false })
      .then(() => { this.errors.delete(symbol); })
      .catch((e: unknown) => { if (!isCancelledError(e)) this.errors.set(symbol, e instanceof Error ? e.message : "드로잉을 불러오지 못했습니다"); })
      .finally(() => { this.loads.delete(symbol); this.emit(); });
    this.loads.set(symbol, task);
    return task;
  }

  refresh() { for (const symbol of this.symbols) void this.load(symbol); }
  dataChanged() { this.refresh(); }

  drawings(symbol: string): DrawingBody[] {
    const merged = new Map<string, DrawingBody>((this.client.getQueryData<Drawing[]>(key(symbol)) ?? []).map((d) => [d.id, d]));
    for (const { intent } of this.desired.values()) {
      if (intent.symbol !== symbol) continue;
      if (intent.want.kind === "delete") merged.delete(intent.id); else merged.set(intent.id, intent.want.body);
    }
    return [...merged.values()].sort((a, b) => a.z - b.z);
  }

  history(slot: number) { return this.histories.get(slot) ?? EMPTY_HISTORY; }
  commit(slot: number, ops: readonly DrawingOp[], addHistory = true) {
    if (usePersistStore.getState().phase.kind !== "ready") { toast("서버 연결을 복구한 뒤 드로잉을 편집하세요"); return false; }
    const changed = ops.filter((op) => op.kind !== "update" || !sameContent(op.before, op.after));
    if (!changed.length) return false;
    if (!this.journal) { this.recoveryFailed(); return false; }
    let stagingSucceeded = true;
    const staged: { op: DrawingOp; intent: queue.Intent }[] = [];
    for (const op of changed) {
      const body = op.kind === "delete" ? op.before : op.after;
      try {
        const intent = this.journal.stage({ id: opId(op), symbol: body.symbol, want: queue.wantOf(op), observedRevision: op.kind === "create" ? body.revision : Math.max(body.revision, op.before.revision) });
        staged.push({ op, intent });
        this.desired.set(intent.id, { intent, state: "pending" });
        this.admit(intent);
      } catch { stagingSucceeded = false; this.stageFailed = true; this.recoveryFailed(); break; }
    }
    if (stagingSucceeded) { if (this.stageFailed) this.recoveryError = null; this.stageFailed = false; }
    if (addHistory && staged.length) this.histories.set(slot, record(this.history(slot), staged.map(({ op }) => op)));
    this.saveFailure = null;
    this.updateSave(); this.pump();
    return staged.length > 0;
  }

  undo(slot: number, redo = false) {
    const current = (id: string) => {
      for (const symbol of this.symbols) { const d = this.drawings(symbol).find((item) => item.id === id); if (d) return d; }
      return null;
    };
    const plan = (redo ? planRedo : planUndo)(this.history(slot), current);
    if (plan.kind === "nothing") return;
    if (plan.kind === "conflict") {
      this.histories.set(slot, plan.history);
      toast("다른 곳에서 바뀐 드로잉이라 되돌리지 않았습니다");
    } else if (this.commit(slot, plan.ops, false)) this.histories.set(slot, plan.history);
    this.emit();
  }

  retry() {
    this.recoveryError = null; this.saveFailure = null;
    try {
      this.journal ??= new DrawingJournal();
      const completing = new Set([...this.cleanups.values()].map((intent) => intent.id));
      for (const id of this.journal.snapshot().ids) if (!this.desired.has(id) && !completing.has(id)) this.recoveryIds.add(id);
    } catch { this.recoveryFailed(); return; }
    for (const id of this.recoveryIds) this.recover(id);
    for (const { intent, state } of this.desired.values()) if (state === "pending") this.admit(intent);
    for (const intent of this.cleanups.values()) this.cleanup(intent);
    this.outbox = queue.retryFailed(this.outbox);
    this.updateSave(); this.pump();
  }
  private flush() { for (const id of queue.flushable(this.outbox)) this.send(id, true); }

  private recoveryFailed() {
    this.recoveryError = "복구 저장소를 쓸 수 없습니다. 이 탭을 닫기 전에 저장 상태를 확인하세요";
    toast(this.recoveryError); this.updateSave();
  }

  private updateSave() {
    if (this.stageFailed || this.recoveryError) this.save = { kind: "failed", reason: "error", message: this.recoveryError ?? "드로잉 복구 기록을 저장하지 못했습니다" };
    else if (this.saveFailure) this.save = this.saveFailure;
    else if ([...this.outbox.lanes.values()].some(queue.isFailed)) this.save = { kind: "failed", reason: "error", message: "드로잉 저장 실패" };
    else if ([...this.outbox.lanes.values()].some((lane) => lane.state === "flying")) this.save = { kind: "saving" };
    else this.save = this.desired.size || this.admissions.size || this.cleanups.size || this.recoveryIds.size ? { kind: "pending" } : { kind: "saved", at: Date.now() };
    this.emit();
  }

  private accept(intent: queue.Intent) {
    const desired = this.desired.get(intent.id);
    if (desired && desired.intent.uuid !== intent.uuid) return;
    this.desired.set(intent.id, { intent, state: "admitted" });
    const lane = this.outbox.lanes.get(intent.id);
    if (!lane || queue.latestIntent(lane).uuid !== intent.uuid) this.outbox = queue.enqueue(this.outbox, intent);
  }

  private recover(id: string) {
    const journal = this.journal;
    if (!journal) return;
    void journal.recover(id).then((intent) => {
      this.recoveryIds.delete(id);
      if (intent) {
        const desired = this.desired.get(id);
        if (!desired || compareIntent(intent, desired.intent) >= 0) {
          this.desired.set(id, { intent, state: "admitted" });
          this.accept(intent);
        }
      } else {
        const desired = this.desired.get(id);
        if (desired && !this.admissions.has(id)) this.desired.delete(id);
      }
      this.updateSave(); this.pump();
    }).catch(() => this.recoveryFailed());
  }

  private admit(intent: queue.Intent) {
    const journal = this.journal;
    if (!journal) return;
    const previous = this.admissions.get(intent.id) ?? Promise.resolve();
    const task = previous.then(() => journal.admit(intent)).then((admitted) => {
      if (admitted) this.accept(intent);
      else if (this.desired.get(intent.id)?.intent.uuid === intent.uuid) this.desired.delete(intent.id);
    }).catch(() => this.recoveryFailed()).finally(() => {
      if (this.admissions.get(intent.id) === task) this.admissions.delete(intent.id);
      this.updateSave(); this.pump();
    });
    this.admissions.set(intent.id, task);
  }

  private cleanup(intent: queue.Intent) {
    this.cleanups.set(intent.uuid, intent);
    void this.journal?.complete(intent).then(() => {
      this.cleanups.delete(intent.uuid); this.updateSave(); this.pump();
    }).catch(() => this.recoveryFailed());
  }

  private pump() {
    if (this.timer !== null) clearTimeout(this.timer);
    for (const id of queue.nextToSend(this.outbox, Date.now())) this.send(id, false);
    const waiting = [...this.outbox.lanes.values()].flatMap((l) => l.state === "waiting" && Number.isFinite(l.retryAt) ? [l.retryAt] : []);
    if (waiting.length) this.timer = setTimeout(() => this.pump(), Math.max(0, Math.min(...waiting) - Date.now()));
  }

  private send(id: string, keepalive: boolean) {
    const lane = this.outbox.lanes.get(id);
    if (lane?.state !== "waiting" || this.launches.has(id)) return;
    const desired = this.desired.get(id);
    if (desired?.intent.uuid !== lane.intent.uuid || desired.state !== "admitted") { this.outbox = queue.drop(this.outbox, id); return; }
    const journal = this.journal;
    if (!journal) { this.outbox = queue.pause(this.outbox, id); this.recoveryFailed(); return; }
    this.launches.add(id);
    void journal.launch(lane.intent, () => {
      const current = this.outbox.lanes.get(id);
      const latest = this.desired.get(id);
      if (current?.state !== "waiting" || current.intent.uuid !== lane.intent.uuid || latest?.intent.uuid !== lane.intent.uuid || latest.state !== "admitted") return false;
      const started = queue.start(this.outbox, id);
      if (!started) return false;
      this.outbox = started.outbox;
      const { want, symbol } = started.send;
      const sending = want.kind === "delete" ? deleteJson(drawingPath(id), { keepalive }) : putJson<Drawing>(drawingPath(id), want.body, { keepalive });
      this.updateSave();
      void sending.then(async (saved) => {
        let loading = this.loads.get(symbol);
        while (loading) { await loading; loading = this.loads.get(symbol); }
        this.client.setQueryData<Drawing[]>(key(symbol), (old = []) => {
          const current = old.find((d) => d.id === id);
          if (saved && current && current.revision > saved.revision) return old;
          return [...old.filter((d) => d.id !== id), ...(saved ? [saved] : [])];
        });
        this.settle(id, { kind: "ok" });
      }).catch((e: unknown) => {
        const outcome: queue.Outcome = e instanceof ApiRequestError && e.code === "stale_revision" ? { kind: "stale" }
          : e instanceof ApiRequestError && (e.code === "bad_request" || e.code === "payload_too_large" || e.code === "not_found") ? { kind: "clientError", tooLarge: e.code === "payload_too_large" }
          : { kind: "networkError" };
        this.settle(id, outcome);
        if (outcome.kind === "stale" || outcome.kind === "clientError") { void this.load(symbol); toast(outcome.kind === "stale" ? "다른 곳의 새 수정이 있어 드로잉을 다시 불러왔습니다" : "드로잉을 저장하지 못했습니다"); }
      });
      return true;
    }).then((launched) => {
      if (launched) return;
      const current = this.outbox.lanes.get(id);
      if (current?.state === "waiting" && current.intent.uuid === lane.intent.uuid) this.outbox = queue.drop(this.outbox, id);
      if (this.desired.get(id)?.intent.uuid === lane.intent.uuid) this.desired.delete(id);
    }).catch(() => {
      const current = this.outbox.lanes.get(id);
      if (current?.state === "waiting" && current.intent.uuid === lane.intent.uuid) this.outbox = queue.pause(this.outbox, id);
      this.recoveryFailed();
    }).finally(() => {
      this.launches.delete(id); this.updateSave(); this.pump();
    });
  }

  private settle(id: string, outcome: queue.Outcome) {
    const settled = queue.settle(this.outbox, id, outcome, Date.now());
    if (!settled) return;
    const lane = this.outbox.lanes.get(id);
    this.outbox = settled.outbox;
    if (lane?.state === "flying" && outcome.kind !== "networkError") {
      if (this.desired.get(id)?.intent.uuid === lane.sent.uuid) this.desired.delete(id);
      this.cleanup(lane.sent);
    }
    if (settled.settled.kind === "rejected") this.saveFailure = settled.settled.tooLarge ? { kind: "failed", reason: "too_large" } : { kind: "failed", reason: "error", message: "드로잉 저장 실패" };
    this.updateSave(); this.pump();
  }
}

const services = new WeakMap<QueryClient, DrawingSync>();
export function drawingSync(client: QueryClient): DrawingSync {
  let sync = services.get(client);
  if (!sync) { sync = new DrawingSync(client); services.set(client, sync); }
  return sync;
}
export function useDrawingVersion(sync: DrawingSync) { return useSyncExternalStore(sync.subscribe, sync.snapshot); }
