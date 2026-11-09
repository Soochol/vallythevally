import type { Period } from "../api/generated/Period";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import type { ShownVenue } from "../lib/venue";
import type { LegendParts } from "./legend";
import type { ThemeTokens } from "./theme";
import { formatKstMinute } from "./time";

export interface SnapshotHead {
  name: string;
  sub: string;
  venue: string;
  period: string;
  takenAt: UnixSeconds;
  legend: LegendParts | null;
}

const PAD_X = 12;
const GAP = 6;
const LABEL_GAP = 3;
const LINE_HEIGHT = 22;
const PAD_BOTTOM = 12;

interface Run {
  text: string;
  size: number;
  weight: number;
  color: string;
}

type KeepTogether = Run[];

export function snapshotFileName(symbol: SymbolCode, venue: ShownVenue | null, period: Period, takenAt: UnixSeconds): string {
  const stamp = formatKstMinute(takenAt).replace(/[-:]/g, "").replace(" ", "-");
  return `${[symbol.replace(":", "-"), venue, period, stamp].filter(Boolean).join("_")}.png`;
}

/** 범례는 DOM이라 `takeScreenshot`에 찍히지 않는다. 그래서 머리 띠에 다시 그린다. */
export function composeSnapshot(chart: HTMLCanvasElement, head: SnapshotHead, tokens: ThemeTokens, pxPerCssPx: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  const ctx = out.getContext("2d")!;
  const font = (r: Run) => `${r.weight} ${r.size}px ${tokens.fontFamily}`;
  const groupWidth = (u: KeepTogether) =>
    u.reduce((w, r, i) => {
      ctx.font = font(r);
      return w + ctx.measureText(r.text).width + (i > 0 ? LABEL_GAP : 0);
    }, 0);

  const run = (text: string, size: number, weight: number, color: string): KeepTogether => (text === "" ? [] : [{ text, size, weight, color }]);
  const title = [
    run(head.name, 15, 650, tokens.text),
    run(head.sub, 12, 400, tokens.text3),
    run(head.venue, 12, 400, tokens.text2),
    run(head.period, 12, 400, tokens.text3),
  ];
  const legend = head.legend;
  const dir = legend && { up: tokens.up, down: tokens.down, flat: tokens.text2 }[legend.dir];
  const legendGroups: KeepTogether[] =
    legend && dir
      ? [
          run(legend.close, 15, 600, dir),
          run(legend.change, 12, 400, dir),
          run(legend.time, 11, 400, tokens.text2),
          ...legend.cells.map(([label, value]) => [...run(label, 12, 400, tokens.text3), ...run(value, 12, 400, tokens.text)]),
        ]
      : [];

  const width = chart.width / pxPerCssPx;
  const takenAt = run(`${formatKstMinute(head.takenAt)} KST`, 12, 400, tokens.text3);
  const lines: { group: KeepTogether; x: number }[][] = [];
  const place = (groups: KeepTogether[], firstLineEnd: number) => {
    lines.push([]);
    let x = PAD_X;
    let end = firstLineEnd;
    for (const group of groups.filter((g) => g.length > 0)) {
      const w = groupWidth(group);
      if (x > PAD_X && x + w > end) {
        lines.push([]);
        x = PAD_X;
        end = width - PAD_X;
      }
      lines[lines.length - 1]!.push({ group, x });
      x += w + GAP;
    }
  };
  place(title, width - PAD_X - groupWidth(takenAt) - GAP);
  lines[0]!.push({ group: takenAt, x: width - PAD_X - groupWidth(takenAt) });
  if (legendGroups.length > 0) place(legendGroups, width - PAD_X);

  const headPx = Math.round((lines.length * LINE_HEIGHT + PAD_BOTTOM) * pxPerCssPx);
  const border = Math.max(1, Math.round(pxPerCssPx));
  out.width = chart.width;
  out.height = chart.height + headPx;
  ctx.fillStyle = tokens.chartBg;
  ctx.fillRect(0, 0, out.width, headPx);
  ctx.drawImage(chart, 0, headPx);
  ctx.fillStyle = tokens.line;
  ctx.fillRect(0, headPx - border, out.width, border);

  ctx.scale(pxPerCssPx, pxPerCssPx);
  ctx.textBaseline = "alphabetic";
  lines.forEach((line, i) => {
    const y = (i + 1) * LINE_HEIGHT;
    for (const { group, x: start } of line) {
      let x = start;
      for (const r of group) {
        ctx.font = font(r);
        ctx.fillStyle = r.color;
        ctx.fillText(r.text, x, y);
        x += ctx.measureText(r.text).width + LABEL_GAP;
      }
    }
  });
  return out;
}
