import type { ExecutionForensic } from "../../api/generated/ExecutionForensic";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { JournalNote, StoredDayExecutions, StoredExecutionRecord } from "./journalTypes";

const NOTES_STORAGE_KEY = "vally.journal.notes.v1";

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

export function combineDayExecutionsWithForensics(
  daysByDate: ReadonlyMap<string, readonly TradingExecution[]>,
  forensicsDay: string,
  forensics: readonly ExecutionForensic[],
): readonly StoredDayExecutions[] {
  const normalizedForensicsDay = forensicsDay !== "" ? normalizeDayString(forensicsDay) : "";
  const forensicByOrder = new Map<string, ExecutionForensic>();
  for (const item of forensics) forensicByOrder.set(item.orderNo, item);

  const byDay = new Map<string, StoredDayExecutions>();
  for (const [rawDay, executions] of daysByDate.entries()) {
    const day = normalizeDayString(rawDay);
    const matchesForensics = normalizedForensicsDay !== "" && day === normalizedForensicsDay;
    const records: StoredExecutionRecord[] = executions.map((ex) => {
      const f = matchesForensics ? forensicByOrder.get(ex.orderNo) : undefined;
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
    });
    if (records.length > 0) byDay.set(day, { day, executions: records });
  }

  if (normalizedForensicsDay !== "" && !byDay.has(normalizedForensicsDay) && forensics.length > 0) {
    byDay.set(normalizedForensicsDay, {
      day: normalizedForensicsDay,
      executions: forensics.map((f) => ({
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
      })),
    });
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function normalizeDayString(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return raw;
}
