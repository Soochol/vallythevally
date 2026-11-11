import type { Plot, Sample } from "./report-model.ts";

export interface ChartValue { time: string; value: number }
export function plotRuns(plot: Plot, calendar: string[], observationDays: string[]): ChartValue[][] {
  if (plot.style === "step" && plot.sampling === "disclosure") {
    const samples = new Map<string, Sample>(plot.samples.map((p) => [p.day, p]));
    let current: Sample | null = null;
    const expanded: Sample[] = [];
    for (const d of calendar) {
      current = samples.get(d) ?? current;
      if (current) expanded.push({ ...current, day: d as Sample["day"] });
    }
    return split(expanded, () => false);
  }
  const indices = new Map(observationDays.map((d, i) => [d, i]));
  return split(plot.samples, (previous, point) => plot.sampling === "weekly"
    ? Date.parse(point.day) - Date.parse(previous.day) > 7 * 86400000
    : plot.sampling === "daily" && indices.has(previous.day) && indices.has(point.day) && indices.get(point.day)! - indices.get(previous.day)! > 1);
}
function split(samples: Sample[], gap: (previous: Sample, point: Sample) => boolean): ChartValue[][] {
  const runs: ChartValue[][] = [];
  let run: ChartValue[] = [];
  let previous: Sample | null = null;
  for (const p of samples) {
    if (p.value === null || previous && gap(previous, p)) { if (run.length) runs.push(run); run = []; }
    if (p.value !== null) run.push({ time: p.day, value: p.value });
    previous = p;
  }
  if (run.length) runs.push(run);
  return runs;
}
