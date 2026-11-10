import { parseRecord, recordKey, UNSAVED_PREFIX, type Intent, type Want } from "./outbox";

export const COMPLETION_PREFIX = "vv.drawing.completed.";
export const completionKey = (id: string) => `${COMPLETION_PREFIX}${id}`;

export const STAGING_PREFIX = "vv.unsaved.drawing-intent.";
export const stageKey = (uuid: string) => `${STAGING_PREFIX}${uuid}`;
export const journalLock = (id: string) => `vv.drawing.journal.${id}`;
export const compareIntent = (a: Pick<Intent, "order" | "uuid">, b: Pick<Intent, "order" | "uuid">): number => a.order - b.order || (a.uuid > b.uuid ? 1 : a.uuid < b.uuid ? -1 : 0);

export function parseJournalRecord(raw: unknown): Intent | null {
  if (typeof raw !== "object" || raw === null || !("v" in raw) || raw.v !== 2 || !("uuid" in raw) || typeof raw.uuid !== "string" || !raw.uuid || !("order" in raw) || typeof raw.order !== "number" || !Number.isSafeInteger(raw.order) || raw.order < 0) return null;
  const legacy = parseRecord({ ...raw, v: 1 });
  if (legacy === null || (legacy.want.kind === "put" && (legacy.want.reserved !== true || legacy.lastRevision < legacy.want.body.revision))) return null;
  return { ...legacy, v: 2, uuid: raw.uuid, order: raw.order };
}

const invalid = () => new Error("드로잉 복구 기록을 읽지 못했습니다");
const isCounter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function nextCounter(value: number): number {
  if (!isCounter(value) || value === Number.MAX_SAFE_INTEGER) throw new Error("드로잉 복구 기록의 범위를 초과했습니다");
  return value + 1;
}
const sameIntent = (a: Intent, b: Intent): boolean =>
  a.id === b.id && a.symbol === b.symbol && a.uuid === b.uuid && a.order === b.order && a.lastRevision === b.lastRevision &&
  a.want.kind === b.want.kind && (a.want.kind === "delete" || (b.want.kind === "put" && a.want.reserved === b.want.reserved && JSON.stringify(a.want.body) === JSON.stringify(b.want.body)));

function json(raw: string | null): unknown {
  try { return raw === null ? null : JSON.parse(raw); } catch { return null; }
}

type Completion = Pick<Intent, "id" | "order" | "uuid" | "lastRevision"> & { v: 1 };
function parseCompletion(raw: unknown): Completion | null {
  if (typeof raw !== "object" || raw === null || !("v" in raw) || raw.v !== 1 || !("id" in raw) || typeof raw.id !== "string" || !("uuid" in raw) || typeof raw.uuid !== "string" || !raw.uuid || !("order" in raw) || typeof raw.order !== "number" || !Number.isSafeInteger(raw.order) || raw.order < 0 || !("lastRevision" in raw) || typeof raw.lastRevision !== "number" || !Number.isSafeInteger(raw.lastRevision) || raw.lastRevision < 0) return null;
  return { v: 1, id: raw.id, uuid: raw.uuid, order: raw.order, lastRevision: raw.lastRevision };
}

export class DrawingJournal {
  private observed = new Map<string, { order: number; revision: number }>();

  constructor(private storage: Storage = localStorage, private locks: Pick<LockManager, "request"> | undefined = globalThis.navigator?.locks) {}

  private completion(id: string): Completion | null {
    const raw = this.storage.getItem(completionKey(id));
    if (raw === null) return null;
    const completed = parseCompletion(json(raw));
    if (!completed || completed.id !== id) throw invalid();
    return completed;
  }

  private retired(intent: Intent): boolean {
    const completed = this.completion(intent.id);
    return completed !== null && compareIntent(intent, completed) <= 0;
  }

  private retire(intent: Intent): void {
    if (this.staged(intent)) this.storage.removeItem(stageKey(intent.uuid));
    const current = this.current(intent.id);
    if (current && sameIntent(current, intent)) this.storage.removeItem(recordKey(intent.id));
  }

  snapshot(): { intents: Intent[]; ids: string[] } {
    const intents: Intent[] = [];
    const ids = new Set<string>();
    for (const k of Object.keys(this.storage)) {
      if (k.startsWith(COMPLETION_PREFIX)) { this.completion(k.slice(COMPLETION_PREFIX.length)); continue; }
      if (!k.startsWith(UNSAVED_PREFIX) && !k.startsWith(STAGING_PREFIX)) continue;
      const raw = json(this.storage.getItem(k));
      const intent = parseJournalRecord(raw);
      if (intent && (k === recordKey(intent.id) || k === stageKey(intent.uuid))) {
        ids.add(intent.id);
        if (!this.retired(intent) && (k === stageKey(intent.uuid) || this.staged(intent))) intents.push(intent);
      } else {
        const legacy = parseRecord(raw);
        if (legacy && k === recordKey(legacy.id)) ids.add(legacy.id);
      }
    }
    return { intents, ids: [...ids] };
  }

  stage(input: { id: string; symbol: string; want: Want; observedRevision: number }, clock: () => number = Date.now): Intent {
    const { id, symbol } = input;
    if (!isCounter(input.observedRevision) || !parseRecord({ v: 1, id, symbol, want: input.want, lastRevision: input.observedRevision })) throw invalid();
    const uuid = crypto.randomUUID();
    const now = clock();
    if (!isCounter(now)) throw invalid();
    const completed = this.completion(id);
    const local = this.observed.get(id);
    let order = Math.max(now, nextCounter(local?.order ?? 0), completed ? nextCounter(completed.order) : 0);
    let revision = Math.max(input.observedRevision, local?.revision ?? 0, completed?.lastRevision ?? 0);
    const shared = json(this.storage.getItem(recordKey(id)));
    const sharedIntent = parseJournalRecord(shared);
    if (sharedIntent) { order = Math.max(order, nextCounter(sharedIntent.order)); revision = Math.max(revision, sharedIntent.lastRevision); }
    const legacy = parseRecord(shared);
    if (legacy) { const floor = Math.max(legacy.lastRevision, legacy.want.kind === "put" ? legacy.want.body.revision : 0); order = Math.max(order, nextCounter(floor)); revision = Math.max(revision, floor); }
    for (const intent of this.snapshot().intents) {
      if (intent.id !== id) continue;
      order = Math.max(order, nextCounter(intent.order));
      revision = Math.max(revision, intent.lastRevision);
    }
    const want: Want = input.want.kind === "delete" ? { kind: "delete" } : {
      kind: "put", reserved: true, body: { ...input.want.body, revision: Math.max(now, nextCounter(input.want.body.revision), nextCounter(revision)) },
    };
    if (want.kind === "put") revision = want.body.revision;
    const candidate: Intent = { v: 2, id, symbol, uuid, order, want, lastRevision: revision };
    const serialized = JSON.stringify(candidate);
    const intent = parseJournalRecord(json(serialized));
    if (!intent) throw new Error("드로잉 복구 기록을 만들지 못했습니다");
    this.storage.setItem(stageKey(intent.uuid), serialized);
    this.observed.set(id, { order, revision });
    return intent;
  }

  private async transaction<T>(id: string, work: () => T): Promise<T> {
    if (!this.locks) return Promise.reject(new Error("이 브라우저에서 드로잉 복구 잠금을 사용할 수 없습니다"));
    return this.locks.request(journalLock(id), work);
  }

  private staged(intent: Intent): boolean {
    const raw = this.storage.getItem(stageKey(intent.uuid));
    if (raw === null) return false;
    const stored = parseJournalRecord(json(raw));
    if (!stored || !sameIntent(stored, intent)) throw invalid();
    return true;
  }

  private current(id: string): Intent | null {
    const current = parseJournalRecord(json(this.storage.getItem(recordKey(id))));
    if (current && current.id !== id) throw invalid();
    return current;
  }

  private migrate(id: string): void {
    const key = recordKey(id);
    const raw = this.storage.getItem(key);
    const legacy = parseRecord(json(raw));
    if (!legacy) return;
    if (legacy.id !== id) throw invalid();
    const floor = Math.max(legacy.lastRevision, legacy.want.kind === "put" ? legacy.want.body.revision : 0);
    const completed = this.completion(id);
    if (completed && completed.order >= floor) { this.storage.removeItem(key); return; }
    for (const stage of this.snapshot().intents) {
      if (stage.id !== id || stage.order !== floor) continue;
      if (legacy.want.kind === "put" && !legacy.want.reserved && legacy.want.body.revision === 0 && (stage.want.kind !== "put" || stage.want.body.revision <= floor)) continue;
      const want: Want = legacy.want.kind === "put" && stage.want.kind === "put" ? {
        kind: "put", reserved: true, body: { ...legacy.want.body, revision: legacy.want.reserved || legacy.want.body.revision > 0 ? legacy.want.body.revision : stage.want.body.revision },
      } : legacy.want;
      const expected = parseJournalRecord({ v: 2, id, symbol: legacy.symbol, uuid: stage.uuid, order: floor, want, lastRevision: Math.max(floor, want.kind === "put" ? want.body.revision : 0) });
      if (expected && sameIntent(stage, expected)) {
        if (this.storage.getItem(key) === raw) this.storage.removeItem(key);
        return;
      }
    }
    const want: Want = legacy.want.kind === "delete" ? { kind: "delete" } : {
      kind: "put", reserved: true, body: { ...legacy.want.body, revision: legacy.want.reserved || legacy.want.body.revision > 0 ? legacy.want.body.revision : Math.max(Date.now(), nextCounter(floor)) },
    };
    const intent = parseJournalRecord({ v: 2, id, symbol: legacy.symbol, uuid: crypto.randomUUID(), order: floor, want, lastRevision: Math.max(floor, want.kind === "put" ? want.body.revision : 0) });
    if (!intent) throw invalid();
    this.storage.setItem(stageKey(intent.uuid), JSON.stringify(intent));
    if (this.storage.getItem(key) === raw) this.storage.removeItem(key);
  }

  admit(intent: Intent): Promise<boolean> {
    return this.transaction(intent.id, () => {
      this.migrate(intent.id);
      if (this.retired(intent)) { this.retire(intent); return false; }
      if (!this.staged(intent)) return false;
      const current = this.current(intent.id);
      if (current && this.staged(current) && !this.retired(current) && compareIntent(current, intent) > 0) return false;
      if (current?.uuid === intent.uuid && !sameIntent(current, intent)) throw invalid();
      if (!current || !sameIntent(current, intent)) this.storage.setItem(recordKey(intent.id), JSON.stringify(intent));
      return true;
    });
  }

  recover(id: string): Promise<Intent | null> {
    return this.transaction(id, () => {
      this.completion(id);
      this.migrate(id);
      for (const key of Object.keys(this.storage)) {
        if (!key.startsWith(STAGING_PREFIX)) continue;
        const intent = parseJournalRecord(json(this.storage.getItem(key)));
        if (intent?.id === id && key === stageKey(intent.uuid) && this.retired(intent)) this.retire(intent);
      }
      let current = this.current(id);
      if (current && (this.retired(current) || !this.staged(current))) { this.storage.removeItem(recordKey(id)); current = null; }
      for (const intent of this.snapshot().intents) {
        if (intent.id === id && (!current || compareIntent(intent, current) > 0)) current = intent;
      }
      if (current) this.storage.setItem(recordKey(id), JSON.stringify(current));
      return current;
    });
  }

  isSendable(intent: Intent): boolean {
    if (this.retired(intent) || !this.staged(intent)) return false;
    const current = this.current(intent.id);
    if (current?.uuid === intent.uuid && !sameIntent(current, intent)) throw invalid();
    return current !== null && sameIntent(current, intent);
  }

  launch(intent: Intent, work: () => boolean): Promise<boolean> {
    return this.transaction(intent.id, () => this.isSendable(intent) && work());
  }

  complete(intent: Intent): Promise<void> {
    return this.transaction(intent.id, () => {
      const previous = this.completion(intent.id);
      const staged = this.staged(intent);
      const current = this.current(intent.id);
      if (current?.uuid === intent.uuid && !sameIntent(current, intent)) throw invalid();
      if (!staged && (!current || !sameIntent(current, intent))) return;
      const greatest = previous && compareIntent(previous, intent) > 0 ? previous : intent;
      const shared = current && compareIntent(current, greatest) <= 0 ? current : null;
      let lastRevision = Math.max(previous?.lastRevision ?? 0, intent.lastRevision, shared?.lastRevision ?? 0);
      const retired: Intent[] = [];
      for (const key of Object.keys(this.storage)) {
        if (!key.startsWith(STAGING_PREFIX)) continue;
        const stage = parseJournalRecord(json(this.storage.getItem(key)));
        if (stage && key === stageKey(stage.uuid) && stage.id === intent.id && compareIntent(stage, greatest) <= 0) {
          retired.push(stage);
          lastRevision = Math.max(lastRevision, stage.lastRevision);
        }
      }
      const completed: Completion = { v: 1, id: intent.id, order: greatest.order, uuid: greatest.uuid, lastRevision };
      this.storage.setItem(completionKey(intent.id), JSON.stringify(completed));
      for (const stage of retired.sort(compareIntent)) this.retire(stage);
      if (shared) this.retire(shared);
    });
  }
}
