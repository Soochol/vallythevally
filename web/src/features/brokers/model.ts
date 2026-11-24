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

function lastKnownCumulativeBefore(cells: readonly BrokerCell[], limit: number): number | null {
  for (let i = Math.min(limit, cells.length) - 1; i >= 0; i--) {
    const cumulative = cells[i]?.cumulative ?? null;
    if (cumulative !== null) return cumulative;
  }
  return null;
}

function lastKnownCumulative(row: BrokerRow): number | null {
  return lastKnownCumulativeBefore(row.cells, row.cells.length);
}

function hasGapBetween(gaps: readonly (readonly [UnixSeconds, UnixSeconds])[], prevTime: UnixSeconds, currTime: UnixSeconds): boolean {
  for (const [from, to] of gaps) {
    if (from < currTime && to > prevTime) return true;
  }
  return false;
}

export function appendSnapshots(
  state: BrokerState,
  snapshots: readonly FeedBrokers[],
  gaps: readonly (readonly [UnixSeconds, UnixSeconds])[],
): BrokerState {
  if (snapshots.length === 0) return state;
  const { grid } = state;
  const oldCols = grid.times.length;
  const lastExisting = oldCols > 0 ? grid.times[oldCols - 1]! : undefined;

  const effective: FeedBrokers[] = [];
  for (const snapshot of snapshots) {
    const prev = effective.length > 0 ? effective[effective.length - 1]!.t : lastExisting;
    if (prev !== undefined && snapshot.t < prev) continue;
    if (effective.length > 0 && snapshot.t === effective[effective.length - 1]!.t) {
      effective[effective.length - 1] = snapshot;
    } else {
      effective.push(snapshot);
    }
  }
  if (effective.length === 0) return state;

  const replaceLast = lastExisting !== undefined && effective[0]!.t === lastExisting;
  const baseCols = replaceLast ? oldCols - 1 : oldCols;
  const totalCols = baseCols + effective.length;

  const times = new Array<UnixSeconds>(totalCols);
  const gapBefore = new Array<boolean>(totalCols);
  for (let i = 0; i < baseCols; i++) {
    times[i] = grid.times[i]!;
    gapBefore[i] = grid.gapBefore[i]!;
  }
  for (let k = 0; k < effective.length; k++) {
    const col = baseCols + k;
    const currTime = effective[k]!.t;
    times[col] = currTime;
    if (col === 0) {
      gapBefore[col] = false;
    } else if (replaceLast && k === 0) {
      gapBefore[col] = grid.gapBefore[oldCols - 1]! || hasGapBetween(gaps, times[col - 1]!, currTime);
    } else {
      const pending = col === oldCols && state.gapPending;
      gapBefore[col] = pending || hasGapBetween(gaps, times[col - 1]!, currTime);
    }
  }

  const mutableRows = new Map<string, { code: string; name: string; cells: BrokerCell[]; lastCumulative: number | null }>();
  for (const row of grid.rows) {
    const cells = new Array<BrokerCell>(totalCols);
    for (let i = 0; i < baseCols; i++) cells[i] = row.cells[i]!;
    for (let i = baseCols; i < totalCols; i++) cells[i] = ABSENT;
    mutableRows.set(row.code, {
      code: row.code,
      name: row.name,
      cells,
      lastCumulative: lastKnownCumulativeBefore(row.cells, baseCols),
    });
  }

  for (let k = 0; k < effective.length; k++) {
    const col = baseCols + k;
    const members = netBySnapshot(effective[k]!);
    for (const [code, member] of members) {
      let entry = mutableRows.get(code);
      if (entry === undefined) {
        entry = { code, name: member.name, cells: new Array<BrokerCell>(totalCols).fill(ABSENT), lastCumulative: null };
        mutableRows.set(code, entry);
      }
      const previous = entry.lastCumulative;
      entry.cells[col] = { present: true, cumulative: member.net, net: member.net - (previous ?? 0), first: previous === null };
      entry.lastCumulative = member.net;
      entry.name = member.name;
    }
  }

  const rows: BrokerRow[] = [];
  for (const entry of mutableRows.values()) {
    rows.push({ code: entry.code, name: entry.name, cells: entry.cells });
  }
  return { grid: { times, gapBefore, rows }, gapPending: false };
}

export function reduceBrokers(state: BrokerState, event: BrokerEvent): BrokerState {
  switch (event.type) {
    case "snapshot":
      return appendSnapshots(state, [event.brokers], []);
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
