import type { ExecutionForensic } from "../../api/generated/ExecutionForensic";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { JournalNote, StoredDayExecutions, StoredExecutionRecord } from "./journalTypes";

const NOTES_STORAGE_KEY = "vally.journal.notes.v1";
const HISTORY_STORAGE_KEY = "vally.journal.history.v1";
const MAX_HISTORY_DAYS = 180;

export function loadJournalNotes(): Record<string, JournalNote> {
  try {
    const raw = localStorage.getItem(NOTES_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, JournalNote> = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const memo = typeof rec.memo === "string" ? rec.memo : "";
      const tags = Array.isArray(rec.tags) ? rec.tags.filter((x): x is string => typeof x === "string") : [];
      out[id] = { memo, tags };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveJournalNotes(notes: Record<string, JournalNote>): void {
  try {
    localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
  } catch {}
}

export function loadExecutionHistory(): readonly StoredDayExecutions[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: StoredDayExecutions[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.day !== "string" || !Array.isArray(obj.executions)) continue;
      valid.push({ day: obj.day, executions: obj.executions as StoredExecutionRecord[] });
    }
    return valid;
  } catch {
    return [];
  }
}

export function mergeAndStoreExecutions(
  day: string,
  executions: readonly TradingExecution[],
  forensics: readonly ExecutionForensic[],
): readonly StoredDayExecutions[] {
  const existing = loadExecutionHistory();
  if (day === "" || (executions.length === 0 && forensics.length === 0)) return existing;

  const forensicByOrder = new Map<string, ExecutionForensic>();
  for (const f of forensics) forensicByOrder.set(f.orderNo, f);

  const normalizedDay = normalizeDayString(day);
  const records: StoredExecutionRecord[] =
    executions.length > 0
      ? executions.map((ex) => {
          const f = forensicByOrder.get(ex.orderNo);
          return {
            orderNo: ex.orderNo,
            code: ex.code,
            name: ex.name,
            side: ex.side,
            quantity: ex.quantity,
            price: ex.price,
            time: ex.time,
            venue: ex.venue,
            mfePct: f?.mfePct ?? null,
            maePct: f?.maePct ?? null,
            fillAt: f?.fillAt ?? null,
          };
        })
      : forensics.map((f) => ({
          orderNo: f.orderNo,
          code: f.code,
          name: f.name,
          side: f.side,
          quantity: f.quantity,
          price: f.price,
          time: f.time,
          venue: "krx",
          mfePct: f.mfePct,
          maePct: f.maePct,
          fillAt: f.fillAt,
        }));

  const byDay = new Map<string, StoredDayExecutions>();
  for (const entry of existing) byDay.set(normalizeDayString(entry.day), entry);
  byDay.set(normalizedDay, { day: normalizedDay, executions: records });

  const merged = [...byDay.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-MAX_HISTORY_DAYS);

  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(merged));
  } catch {}
  return merged;
}

export function normalizeDayString(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return raw;
}
