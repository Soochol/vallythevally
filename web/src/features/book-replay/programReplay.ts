import type { BookReplayProgramRow } from "../../api/generated/BookReplayProgramRow";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { kstDayBounds } from "../brokers/history";
import type { ProgramLine, ProgramRow } from "../program/program";
import { formatSecond, secondOfDay } from "../trades/tape";

export interface ProgramReplaySlice {
  readonly latest: ProgramRow | undefined;
  readonly lines: readonly ProgramLine[];
  readonly trend: readonly number[];
  readonly rowCount: number;
}

const EMPTY_SLICE: ProgramReplaySlice = {
  latest: undefined,
  lines: [],
  trend: [],
  rowCount: 0,
};

export function sliceProgramReplayAt(
  rows: readonly BookReplayProgramRow[],
  gaps: readonly (readonly [UnixSeconds, UnixSeconds])[],
  date: string,
  at: UnixSeconds,
): ProgramReplaySlice {
  const cutoffSec = secondOfDay(at);
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid]!.secondOfDay <= cutoffSec) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return EMPTY_SLICE;

  const sliced: ProgramRow[] = new Array(lo);
  const trend: number[] = new Array(lo);
  for (let i = 0; i < lo; i++) {
    const row = rows[i]!;
    sliced[i] = {
      key: `replay-${i}-${row.secondOfDay}`,
      source: "history",
      time: formatSecond(row.secondOfDay),
      price: row.price,
      netQty: row.netQty,
      netQtyChange: row.netQtyChange,
      netAmountMillionWon: row.netAmountMillionWon,
      buyQty: row.buyQty,
      sellQty: row.sellQty,
    };
    trend[i] = row.netQty;
  }

  const { start: dayStart } = kstDayBounds(date);
  const firstRowTs = dayStart + rows[0]!.secondOfDay;
  const relevantGaps = gaps
    .filter(([fromSec, toSec]) => fromSec <= at && toSec >= firstRowTs)
    .sort((a, b) => a[0] - b[0]);

  const lines: ProgramLine[] = [];
  let gapIndex = 0;
  for (let i = 0; i < lo; i++) {
    const rowTs = dayStart + rows[i]!.secondOfDay;
    while (gapIndex < relevantGaps.length && relevantGaps[gapIndex]![0] <= rowTs) {
      const [fromSec] = relevantGaps[gapIndex]!;
      if (i > 0) {
        lines.push({ kind: "gap", key: `replay-gap-${gapIndex}-${fromSec}`, time: formatSecond(secondOfDay(fromSec)) });
      }
      gapIndex += 1;
    }
    lines.push({ kind: "row", row: sliced[i]! });
  }
  while (gapIndex < relevantGaps.length) {
    const [fromSec] = relevantGaps[gapIndex]!;
    lines.push({ kind: "gap", key: `replay-gap-${gapIndex}-${fromSec}`, time: formatSecond(secondOfDay(fromSec)) });
    gapIndex += 1;
  }

  return {
    latest: sliced[lo - 1],
    lines,
    trend,
    rowCount: lo,
  };
}
