export const SPAN_MINUTES = 5;
const MS_PER_MINUTE = 60_000;

export function lastRowAtOrBefore(recvMs, timeMs) {
  let low = 0;
  let high = recvMs.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (recvMs[middle] <= timeMs) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function entryIndexAt(startMinutes, timeMs, lengthMinutes = SPAN_MINUTES) {
  let low = 0;
  let high = startMinutes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (startMinutes[middle] * MS_PER_MINUTE <= timeMs) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  if (index < 0) return -1;
  return timeMs < (startMinutes[index] + lengthMinutes) * MS_PER_MINUTE ? index : -1;
}
