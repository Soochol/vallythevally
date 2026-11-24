import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { BrokerGrid } from "./model";

export interface BrokerTrackEvent {
  readonly t: UnixSeconds;
  readonly net: number;
  readonly cumulative: number;
  readonly first: boolean;
  readonly gap: boolean;
}

export interface BrokerTrack {
  readonly code: string;
  readonly name: string;
  readonly cumulative: number | null;
  readonly events: readonly BrokerTrackEvent[];
}

export interface BoardAxis {
  readonly from: UnixSeconds;
  readonly to: UnixSeconds;
}

export interface TrackRunPoint {
  readonly t: UnixSeconds;
  readonly cumulative: number;
}

export interface TrackRun {
  readonly points: readonly TrackRunPoint[];
}

const KST_OFFSET_SECONDS = 9 * 3600;
const DAY_SECONDS = 24 * 3600;
const OPEN_SECONDS = 9 * 3600;
const REGULAR_CLOSE_SECONDS = 15 * 3600 + 30 * 60;
const AFTER_HOURS_START_SECONDS = 15 * 3600 + 40 * 60;
const EXTENDED_CLOSE_SECONDS = 20 * 3600;

const FOREIGN_HINTS: readonly string[] = [
  "JP모간",
  "모건스탠리",
  "골드만",
  "씨티",
  "맥쿼리",
  "유비에스",
  "UBS",
  "노무라",
  "다이와",
  "메릴린치",
  "CLSA",
  "HSBC",
  "BNP",
  "도이치",
  "크레디트스위스",
];

export function brokerTracks(grid: BrokerGrid): readonly BrokerTrack[] {
  const tracks: BrokerTrack[] = grid.rows.map((row) => {
    const events: BrokerTrackEvent[] = [];
    let seenAny = false;
    let gapSinceLastEvent = false;
    for (let i = 0; i < grid.times.length; i++) {
      if (seenAny && grid.gapBefore[i]) gapSinceLastEvent = true;
      const cell = row.cells[i];
      if (!cell || !cell.present || cell.cumulative === null || cell.net === null) {
        if (seenAny) gapSinceLastEvent = true;
        continue;
      }
      seenAny = true;
      if (!cell.first && cell.net === 0) continue;
      const gap = !cell.first && gapSinceLastEvent;
      events.push({ t: grid.times[i]!, net: cell.net, cumulative: cell.cumulative, first: cell.first, gap });
      gapSinceLastEvent = false;
    }
    const cumulative = events.length > 0 ? events[events.length - 1]!.cumulative : null;
    return { code: row.code, name: row.name, cumulative, events };
  });
  return tracks.sort((a, b) => Math.abs(b.cumulative ?? 0) - Math.abs(a.cumulative ?? 0));
}

function compressRun(raw: readonly TrackRunPoint[]): TrackRun {
  if (raw.length <= 2) return { points: raw };
  const points: TrackRunPoint[] = [raw[0]!];
  for (let i = 1; i < raw.length - 1; i++) {
    const current = raw[i]!;
    const previous = raw[i - 1]!;
    const next = raw[i + 1]!;
    if (current.cumulative !== previous.cumulative || current.cumulative !== next.cumulative) {
      points.push(current);
    }
  }
  points.push(raw[raw.length - 1]!);
  return { points };
}

export function trackRuns(grid: BrokerGrid): ReadonlyMap<string, readonly TrackRun[]> {
  const result = new Map<string, readonly TrackRun[]>();
  for (const row of grid.rows) {
    const runs: TrackRun[] = [];
    let current: TrackRunPoint[] = [];
    for (let i = 0; i < grid.times.length; i++) {
      const cell = row.cells[i];
      if (!cell || !cell.present || cell.cumulative === null) {
        if (current.length > 0) {
          runs.push(compressRun(current));
          current = [];
        }
        continue;
      }
      if (grid.gapBefore[i] && current.length > 0) {
        runs.push(compressRun(current));
        current = [];
      }
      current.push({ t: grid.times[i]!, cumulative: cell.cumulative });
    }
    if (current.length > 0) runs.push(compressRun(current));
    result.set(row.code, runs);
  }
  return result;
}

export function boardAxis(times: readonly UnixSeconds[], now: UnixSeconds): BoardAxis {
  const reference = times[0] ?? now;
  const dayStart = Math.floor((reference + KST_OFFSET_SECONDS) / DAY_SECONDS) * DAY_SECONDS - KST_OFFSET_SECONDS;
  const open = dayStart + OPEN_SECONDS;
  const regularClose = dayStart + REGULAR_CLOSE_SECONDS;
  const afterHoursStart = dayStart + AFTER_HOURS_START_SECONDS;
  const extendedClose = dayStart + EXTENDED_CLOSE_SECONDS;
  const first = times[0];
  const last = times[times.length - 1];
  const from = now < open && first !== undefined && first < open ? first : open;
  const cap = last !== undefined && last > afterHoursStart ? extendedClose : regularClose;
  const latest = last !== undefined && last > now ? last : now;
  const to = Math.max(from, Math.min(latest, cap));
  return { from, to };
}

export function barBins(track: BrokerTrack, axis: BoardAxis, seconds: number): readonly number[] {
  const span = Math.max(axis.to - axis.from, 0);
  const count = Math.max(1, Math.ceil(span / seconds));
  const bins = new Array<number>(count).fill(0);
  for (const event of track.events) {
    if (event.t < axis.from || event.t > axis.to) continue;
    const index = Math.min(Math.floor((event.t - axis.from) / seconds), count - 1);
    bins[index] = bins[index]! + event.net;
  }
  return bins;
}

export function barPeakWithoutFirst(track: BrokerTrack, axis: BoardAxis, seconds: number): number {
  const span = Math.max(axis.to - axis.from, 0);
  const count = Math.max(1, Math.ceil(span / seconds));
  const nonFirst = new Array<number>(count).fill(0);
  const all = new Array<number>(count).fill(0);
  for (const event of track.events) {
    if (event.t < axis.from || event.t > axis.to) continue;
    const index = Math.min(Math.floor((event.t - axis.from) / seconds), count - 1);
    all[index] = all[index]! + event.net;
    if (!event.first) nonFirst[index] = nonFirst[index]! + event.net;
  }
  let peak = 0;
  for (const value of nonFirst) peak = Math.max(peak, Math.abs(value));
  if (peak > 0) return peak;
  for (const value of all) peak = Math.max(peak, Math.abs(value));
  return Math.max(1, peak);
}

function lastIndexAtOrBefore(events: readonly BrokerTrackEvent[], t: UnixSeconds): number {
  let lo = 0;
  let hi = events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function eventsUntil(track: BrokerTrack, t: UnixSeconds | null, limit: number): readonly BrokerTrackEvent[] {
  const { events } = track;
  if (events.length === 0 || limit <= 0) return [];
  const end = t === null ? events.length - 1 : lastIndexAtOrBefore(events, t);
  if (end < 0) return [];
  const start = Math.max(0, end - limit + 1);
  const result: BrokerTrackEvent[] = [];
  for (let i = end; i >= start; i--) result.push(events[i]!);
  return result;
}

export function cumulativeUntil(track: BrokerTrack, t: UnixSeconds | null): number | null {
  if (t === null) return track.cumulative;
  const index = lastIndexAtOrBefore(track.events, t);
  return index < 0 ? null : track.events[index]!.cumulative;
}

export function listOrder(tracks: readonly BrokerTrack[]): { readonly rows: readonly BrokerTrack[]; readonly sellStart: number } {
  const rows = [...tracks].sort((a, b) => (b.cumulative ?? 0) - (a.cumulative ?? 0));
  const sellIndex = rows.findIndex((row) => (row.cumulative ?? 0) < 0);
  return { rows, sellStart: sellIndex === -1 ? rows.length : sellIndex };
}

export function isForeignBroker(name: string): boolean {
  const upper = name.toUpperCase();
  return FOREIGN_HINTS.some((hint) => upper.includes(hint));
}

export function foreignSum(tracks: readonly BrokerTrack[], t: UnixSeconds | null): number | null {
  let observed = false;
  let total = 0;
  for (const track of tracks) {
    if (!isForeignBroker(track.name)) continue;
    const value = cumulativeUntil(track, t);
    if (value === null) continue;
    observed = true;
    total += value;
  }
  return observed ? total : null;
}

export function barBinSeconds(cardWidth: number): number {
  if (cardWidth < 140) return 600;
  if (cardWidth < 220) return 300;
  return 60;
}
