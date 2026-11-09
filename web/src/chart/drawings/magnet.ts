import type { Bar } from "../../api/generated/Bar";
import type { PriceAxis } from "./anchor";

export type MagnetStrength = "weak" | "strong";
export type MagnetMode = "off" | MagnetStrength;

export interface MagnetPrefs {
  on: boolean;
  strength: MagnetStrength;
}

export type MagnetSource = (barIndex: number) => readonly number[];

export const WEAK_RADIUS_PX = 16;

export function effectiveMagnet(prefs: MagnetPrefs, invert: boolean): MagnetMode {
  return prefs.on !== invert ? prefs.strength : "off";
}

export function ohlcSource(bars: readonly Bar[]): MagnetSource {
  return (i) => {
    const b = bars[i];
    return b === undefined ? [] : [b.o, b.h, b.l, b.c];
  };
}

export interface MagnetInput {
  logical: number;
  price: number;
  y: number;
}

export interface Snapped {
  logical: number;
  price: number;
  onCandidate: boolean;
}

export function snap(raw: MagnetInput, mode: MagnetMode, sources: readonly MagnetSource[], price: Pick<PriceAxis, "toY">): Snapped {
  if (mode === "off") return { logical: raw.logical, price: raw.price, onCandidate: false };
  const logical = Math.max(0, Math.round(raw.logical));
  let best: { price: number; distance: number } | null = null;
  for (const source of sources) {
    for (const candidate of source(logical)) {
      const y = price.toY(candidate);
      if (y === null) continue;
      const distance = Math.abs(y - raw.y);
      if (best === null || distance < best.distance) best = { price: candidate, distance };
    }
  }
  if (best === null || (mode === "weak" && best.distance > WEAK_RADIUS_PX)) return { logical, price: raw.price, onCandidate: false };
  return { logical, price: best.price, onCandidate: true };
}
