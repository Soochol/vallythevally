import type { FeedBrokers } from "../../api/generated/FeedBrokers";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";

export interface BrokerCell {
  readonly present: boolean;
  readonly cumulative: number | null;
  readonly net: number | null;
  readonly first: boolean;
}

export interface BrokerRow {
  readonly code: string;
  readonly name: string;
  readonly cells: readonly BrokerCell[];
}

export interface BrokerGrid {
  readonly times: readonly UnixSeconds[];
  readonly gapBefore: readonly boolean[];
  readonly rows: readonly BrokerRow[];
}

export interface BrokerState {
  readonly grid: BrokerGrid;
  readonly gapPending: boolean;
}

export type BrokerEvent =
  | { readonly type: "snapshot"; readonly brokers: FeedBrokers }
  | { readonly type: "link"; readonly live: boolean }
  | { readonly type: "resync" };

export const EMPTY_BROKER_STATE: BrokerState = { grid: { times: [], gapBefore: [], rows: [] }, gapPending: false };

const ABSENT: BrokerCell = { present: false, cumulative: null, net: null, first: false };

function netBySnapshot(brokers: FeedBrokers): Map<string, { name: string; net: number }> {
  const members = new Map<string, { name: string; net: number }>();
  for (const buy of brokers.buys) members.set(buy.code, { name: buy.name, net: buy.qty });
  for (const sell of brokers.sells) {
    const known = members.get(sell.code);
    members.set(sell.code, { name: known?.name ?? sell.name, net: (known?.net ?? 0) - sell.qty });
  }
  return members;
}

function lastKnownCumulative(row: BrokerRow): number | null {
  for (let i = row.cells.length - 1; i >= 0; i--) {
    const cumulative = row.cells[i]?.cumulative ?? null;
    if (cumulative !== null) return cumulative;
  }
  return null;
}

function appendSnapshot(state: BrokerState, brokers: FeedBrokers): BrokerState {
  const { grid } = state;
  const last = grid.times[grid.times.length - 1];
  if (last !== undefined && brokers.t <= last) return state;
  const members = netBySnapshot(brokers);
  const rowsByCode = new Map(grid.rows.map((row) => [row.code, row]));
  const columns = grid.times.length;
  for (const code of members.keys()) {
    if (!rowsByCode.has(code)) rowsByCode.set(code, { code, name: members.get(code)!.name, cells: Array.from({ length: columns }, () => ABSENT) });
  }
  const rows = [...rowsByCode.values()].map((row): BrokerRow => {
    const member = members.get(row.code);
    if (member === undefined) return { ...row, cells: [...row.cells, ABSENT] };
    const previous = lastKnownCumulative(row);
    const cell: BrokerCell = { present: true, cumulative: member.net, net: member.net - (previous ?? 0), first: previous === null };
    return { ...row, name: member.name, cells: [...row.cells, cell] };
  });
  return { grid: { times: [...grid.times, brokers.t], gapBefore: [...grid.gapBefore, state.gapPending], rows }, gapPending: false };
}

export function reduceBrokers(state: BrokerState, event: BrokerEvent): BrokerState {
  switch (event.type) {
    case "snapshot":
      return appendSnapshot(state, event.brokers);
    case "link":
      return event.live || state.gapPending ? state : { ...state, gapPending: true };
    case "resync":
      return state.gapPending ? state : { ...state, gapPending: true };
  }
}

export function cumulativeAt(row: BrokerRow, index: number): number | null {
  for (let i = Math.min(index, row.cells.length - 1); i >= 0; i--) {
    const cumulative = row.cells[i]?.cumulative ?? null;
    if (cumulative !== null) return cumulative;
  }
  return null;
}

export function sortedRows(grid: BrokerGrid): readonly BrokerRow[] {
  const finalNet = (row: BrokerRow) => Math.abs(lastKnownCumulative(row) ?? 0);
  return [...grid.rows].sort((a, b) => finalNet(b) - finalNet(a));
}

export interface LineSegment {
  readonly from: number;
  readonly values: readonly number[];
}

export function lineSegments(row: BrokerRow): readonly LineSegment[] {
  const segments: { from: number; values: number[] }[] = [];
  let continuing = false;
  for (let index = 0; index < row.cells.length; index++) {
    const cell = row.cells[index];
    const cumulative = cell?.cumulative ?? null;
    if (!cell?.present || cumulative === null) {
      continuing = false;
      continue;
    }
    if (!continuing) segments.push({ from: index, values: [] });
    segments[segments.length - 1]?.values.push(cumulative);
    continuing = true;
  }
  return segments;
}

export function startedAt(grid: BrokerGrid): UnixSeconds | null {
  return grid.times[0] ?? null;
}

export interface TimeTick {
  readonly column: number;
  readonly time: UnixSeconds;
}

const TICK_SECONDS = 30 * 60;

export function halfHourTicks(times: readonly UnixSeconds[]): readonly TimeTick[] {
  const ticks: TimeTick[] = [];
  let previousSlot: number | null = null;
  times.forEach((time, column) => {
    const slot = Math.floor(time / TICK_SECONDS);
    if (previousSlot !== null && slot > previousSlot) ticks.push({ column, time: slot * TICK_SECONDS });
    previousSlot = slot;
  });
  return ticks;
}
