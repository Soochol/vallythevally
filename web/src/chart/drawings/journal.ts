import { parseRecord, recordKey, UNSAVED_PREFIX, type Intent, type Want } from "./outbox";

export const STAGING_PREFIX = "vv.unsaved.drawing-intent.";
export const stageKey = (uuid: string) => `${STAGING_PREFIX}${uuid}`;
export const journalLock = (id: string) => `vv.drawing.journal.${id}`;
export const compareIntent = (a: Intent, b: Intent): number => a.order - b.order || (a.uuid > b.uuid ? 1 : a.uuid < b.uuid ? -1 : 0);

export function parseJournalRecord(raw: unknown): Intent | null {
  if (typeof raw !== "object" || raw === null || !("v" in raw) || raw.v !== 2 || !("uuid" in raw) || typeof raw.uuid !== "string" || !raw.uuid || !("order" in raw) || typeof raw.order !== "number" || !Number.isSafeInteger(raw.order) || raw.order < 0) return null;
  const legacy = parseRecord({ ...raw, v: 1 });
  if (legacy === null || (legacy.want.kind === "put" && (legacy.want.reserved !== true || legacy.lastRevision < legacy.want.body.revision))) return null;
  return { ...legacy, v: 2, uuid: raw.uuid, order: raw.order };
}

function json(raw: string | null): unknown {
  try { return raw === null ? null : JSON.parse(raw); } catch { return null; }
}

export class DrawingJournal {
  private observed = new Map<string, { order: number; revision: number }>();

  constructor(private storage: Storage = localStorage, private locks: Pick<LockManager, "request"> | undefined = globalThis.navigator?.locks) {}

  snapshot(): { intents: Intent[]; ids: string[] } {
    const intents: Intent[] = [];
    const ids = new Set<string>();
    for (const k of Object.keys(this.storage)) {
      if (!k.startsWith(UNSAVED_PREFIX) && !k.startsWith(STAGING_PREFIX)) continue;
      const raw = json(this.storage.getItem(k));
      const intent = parseJournalRecord(raw);
      if (intent && (k === recordKey(intent.id) || k === stageKey(intent.uuid))) {
        ids.add(intent.id);
        if (k === stageKey(intent.uuid) || this.staged(intent)) intents.push(intent);
      } else {
        const legacy = parseRecord(raw);
        if (legacy && k === recordKey(legacy.id)) ids.add(legacy.id);
      }
    }
    return { intents, ids: [...ids] };
  }

  stage(input: { id: string; symbol: string; want: Want; observedRevision: number }, clock: () => number = Date.now): Intent {
    const { id, symbol } = input;
    const local = this.observed.get(id);
    let order = Math.max(0, clock(), (local?.order ?? 0) + 1);
    let revision = Math.max(input.observedRevision, local?.revision ?? 0);
    const shared = json(this.storage.getItem(recordKey(id)));
    const sharedIntent = parseJournalRecord(shared);
    if (sharedIntent) { order = Math.max(order, sharedIntent.order + 1); revision = Math.max(revision, sharedIntent.lastRevision); }
    const legacy = parseRecord(shared);
    if (legacy) { order = Math.max(order, legacy.lastRevision + 1); revision = Math.max(revision, legacy.lastRevision, legacy.want.kind === "put" ? legacy.want.body.revision : 0); }
    for (const intent of this.snapshot().intents) {
      if (intent.id !== id) continue;
      order = Math.max(order, intent.order + 1);
      revision = Math.max(revision, intent.lastRevision);
    }
    const want: Want = input.want.kind === "delete" ? { kind: "delete" } : {
      kind: "put", reserved: true, body: { ...input.want.body, revision: Math.max(clock(), input.want.body.revision + 1, revision + 1) },
    };
    if (want.kind === "put") revision = want.body.revision;
    const candidate: Intent = { v: 2, id, symbol, uuid: crypto.randomUUID(), order, want, lastRevision: revision };
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
    return parseJournalRecord(json(this.storage.getItem(stageKey(intent.uuid))))?.uuid === intent.uuid;
  }

  private current(id: string): Intent | null { return parseJournalRecord(json(this.storage.getItem(recordKey(id)))); }

  admit(intent: Intent): Promise<boolean> {
    return this.transaction(intent.id, () => {
      if (!this.staged(intent)) return false;
      const current = this.current(intent.id);
      if (current && compareIntent(current, intent) > 0) return false;
      if (current?.uuid !== intent.uuid) this.storage.setItem(recordKey(intent.id), JSON.stringify(intent));
      return true;
    });
  }

  recover(id: string): Promise<Intent | null> {
    return this.transaction(id, () => {
      let current = this.current(id);
      if (current && !this.staged(current)) { this.storage.removeItem(recordKey(id)); current = null; }
      const pending = this.snapshot().intents.filter((intent) => intent.id === id);
      for (const intent of pending) if (!current || compareIntent(intent, current) > 0) current = intent;
      if (!current) {
        const legacy = parseRecord(json(this.storage.getItem(recordKey(id))));
        if (!legacy) return null;
        const floor = Math.max(legacy.lastRevision, legacy.want.kind === "put" ? legacy.want.body.revision : 0);
        const want: Want = legacy.want.kind === "delete" ? { kind: "delete" } : {
          kind: "put", reserved: true, body: { ...legacy.want.body, revision: legacy.want.reserved || legacy.want.body.revision > 0 ? legacy.want.body.revision : Math.max(Date.now(), floor + 1) },
        };
        current = { v: 2, id, symbol: legacy.symbol, uuid: crypto.randomUUID(), order: floor, want, lastRevision: Math.max(floor, want.kind === "put" ? want.body.revision : 0) };
        this.storage.setItem(stageKey(current.uuid), JSON.stringify(current));
      }
      this.storage.setItem(recordKey(id), JSON.stringify(current));
      return current;
    });
  }

  isSendable(intent: Intent): boolean { return this.staged(intent) && this.current(intent.id)?.uuid === intent.uuid; }

  complete(intent: Intent): Promise<void> {
    return this.transaction(intent.id, () => {
      if (!this.staged(intent) && this.current(intent.id)?.uuid !== intent.uuid) return;
      const older: Intent[] = [];
      for (const k of Object.keys(this.storage)) {
        if (!k.startsWith(STAGING_PREFIX)) continue;
        const stage = parseJournalRecord(json(this.storage.getItem(k)));
        if (stage && k === stageKey(stage.uuid) && stage.id === intent.id && compareIntent(stage, intent) < 0) older.push(stage);
      }
      for (const stage of older.sort(compareIntent)) this.storage.removeItem(stageKey(stage.uuid));
      this.storage.removeItem(stageKey(intent.uuid));
      if (this.current(intent.id)?.uuid === intent.uuid) this.storage.removeItem(recordKey(intent.id));
    });
  }
}
