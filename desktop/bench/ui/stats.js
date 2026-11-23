const FRAME_BUDGET_MS = 1000 / 60;
const MISSED_FRAME_MS = FRAME_BUDGET_MS * 1.5;

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function summarize(values) {
  const sorted = Float64Array.from(values).sort();
  const sum = sorted.reduce((total, value) => total + value, 0);
  return { count: sorted.length, p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99), max: sorted.length ? sorted[sorted.length - 1] : null, mean: sorted.length ? sum / sorted.length : null };
}

function frameReport(intervals, elapsedMs) {
  const missed = intervals.filter((interval) => interval > MISSED_FRAME_MS).length;
  return { ...summarize(intervals), missedFrameMs: MISSED_FRAME_MS, missedFrames: missed, missedRatio: intervals.length ? missed / intervals.length : null, framesPerSecond: elapsedMs > 0 ? (intervals.length * 1000) / elapsedMs : null };
}

if (typeof module !== "undefined") module.exports = { percentile, summarize, frameReport, MISSED_FRAME_MS };
