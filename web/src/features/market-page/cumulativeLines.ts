import type { MarketOverviewIntradayPoint } from "../../api/generated/MarketOverviewIntradayPoint";

export const SUBJECTS = ["individual", "foreign", "institution", "program"] as const;
export type Subject = (typeof SUBJECTS)[number];

export const SUBJECT_LABEL: Record<Subject, string> = { individual: "개인", foreign: "외국인", institution: "기관", program: "프로그램" };

const FIELD: Record<Subject, "individualEok" | "foreignEok" | "institutionEok" | "programEok"> = {
  individual: "individualEok",
  foreign: "foreignEok",
  institution: "institutionEok",
  program: "programEok",
};

export interface LinePoint {
  at: number;
  eok: number;
}

export interface CumulativeLines {
  from: number;
  to: number;
  min: number;
  max: number;
  series: Record<Subject, LinePoint[][]>;
}

export function cumulativeLines(points: readonly MarketOverviewIntradayPoint[]): CumulativeLines | null {
  if (points.length === 0) return null;
  const ordered = points.toSorted((a, b) => a.at - b.at);
  const series = { individual: [], foreign: [], institution: [], program: [] } as Record<Subject, LinePoint[][]>;
  let min = 0;
  let max = 0;
  for (const subject of SUBJECTS) {
    let segment: LinePoint[] = [];
    for (const point of ordered) {
      const raw = point[FIELD[subject]];
      if (raw === null) {
        if (segment.length > 0) series[subject].push(segment);
        segment = [];
        continue;
      }
      const eok = Number(raw);
      min = Math.min(min, eok);
      max = Math.max(max, eok);
      segment.push({ at: point.at, eok });
    }
    if (segment.length > 0) series[subject].push(segment);
  }
  return { from: ordered[0]!.at, to: ordered[ordered.length - 1]!.at, min, max, series };
}

export interface Frame {
  width: number;
  height: number;
}

export function linePath(lines: CumulativeLines, subject: Subject, frame: Frame): string {
  const spanX = Math.max(lines.to - lines.from, 1);
  const spanY = Math.max(lines.max - lines.min, 1);
  const x = (at: number) => ((at - lines.from) / spanX) * frame.width;
  const y = (eok: number) => frame.height - ((eok - lines.min) / spanY) * frame.height;
  return lines.series[subject]
    .map((segment) => (segment.length === 1 ? [segment[0]!, segment[0]!] : segment).map((point, i) => `${i === 0 ? "M" : "L"}${x(point.at).toFixed(1)} ${y(point.eok).toFixed(1)}`).join(" "))
    .join(" ");
}

export function zeroY(lines: CumulativeLines, frame: Frame): number {
  const spanY = Math.max(lines.max - lines.min, 1);
  return frame.height - ((0 - lines.min) / spanY) * frame.height;
}
