import type { Bar } from "../../api/generated/Bar";
import type { VolumeProfilePage } from "../../api/generated/VolumeProfilePage";

export type VolumeProfileMode = "vrvp" | "session";

export interface VolumeProfileBinView {
  readonly low: number;
  readonly high: number;
  readonly mid: number;
  readonly buyVol: number;
  readonly sellVol: number;
  readonly totalVol: number;
}

export interface VolumeProfileResult {
  readonly bins: readonly VolumeProfileBinView[];
  readonly pocPrice: number | null;
  readonly vahPrice: number | null;
  readonly valPrice: number | null;
  readonly maxBinVol: number;
  readonly totalVol: number;
}

export function computeBarVolumeProfile(
  bars: readonly Bar[],
  binsCount = 32,
  valueAreaPct = 70,
): VolumeProfileResult {
  if (bars.length === 0 || binsCount <= 0) {
    return { bins: [], pocPrice: null, vahPrice: null, valPrice: null, maxBinVol: 0, totalVol: 0 };
  }
  let minP = Infinity;
  let maxP = -Infinity;
  for (const b of bars) {
    if (b.l < minP) minP = b.l;
    if (b.h > maxP) maxP = b.h;
  }
  if (!Number.isFinite(minP) || !Number.isFinite(maxP) || maxP <= 0) {
    return { bins: [], pocPrice: null, vahPrice: null, valPrice: null, maxBinVol: 0, totalVol: 0 };
  }
  const span = Math.max(1, maxP - minP);
  const step = span / binsCount;
  const raw = Array.from({ length: binsCount }, (_, idx) => ({
    low: minP + idx * step,
    high: minP + (idx + 1) * step,
    mid: minP + (idx + 0.5) * step,
    buyVol: 0,
    sellVol: 0,
    totalVol: 0,
  }));

  for (const b of bars) {
    const vol = Math.max(0, b.v);
    if (vol === 0) continue;
    const range = b.h - b.l;
    const buyShare = range > 0 ? Math.min(1, Math.max(0, (b.c - b.l) / range)) : b.c >= b.o ? 0.6 : 0.4;
    const loIdx = Math.max(0, Math.min(binsCount - 1, Math.floor((b.l - minP) / step)));
    const hiIdx = Math.max(0, Math.min(binsCount - 1, Math.floor((b.h - minP) / step)));
    const count = hiIdx - loIdx + 1;
    const perBinBuy = (vol * buyShare) / count;
    const perBinSell = (vol * (1 - buyShare)) / count;
    for (let k = loIdx; k <= hiIdx; k++) {
      raw[k]!.buyVol += perBinBuy;
      raw[k]!.sellVol += perBinSell;
      raw[k]!.totalVol += perBinBuy + perBinSell;
    }
  }

  let totalVol = 0;
  let maxBinVol = 0;
  let pocIdx = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!.totalVol;
    totalVol += t;
    if (t > maxBinVol) {
      maxBinVol = t;
      pocIdx = i;
    }
  }
  if (totalVol <= 0) {
    return { bins: raw, pocPrice: null, vahPrice: null, valPrice: null, maxBinVol: 0, totalVol: 0 };
  }

  const target = totalVol * (Math.min(100, Math.max(10, valueAreaPct)) / 100);
  let vaVol = raw[pocIdx]!.totalVol;
  let vaLo = pocIdx;
  let vaHi = pocIdx;
  while (vaVol < target && (vaLo > 0 || vaHi + 1 < raw.length)) {
    const down = vaLo > 0 ? raw[vaLo - 1]!.totalVol : -1;
    const up = vaHi + 1 < raw.length ? raw[vaHi + 1]!.totalVol : -1;
    if (up >= down && vaHi + 1 < raw.length) {
      vaHi++;
      vaVol += raw[vaHi]!.totalVol;
    } else if (vaLo > 0) {
      vaLo--;
      vaVol += raw[vaLo]!.totalVol;
    } else {
      break;
    }
  }
  return {
    bins: raw,
    pocPrice: raw[pocIdx]!.mid,
    vahPrice: raw[vaHi]!.high,
    valPrice: raw[vaLo]!.low,
    maxBinVol,
    totalVol,
  };
}

export function fromServerVolumeProfile(page: VolumeProfilePage): VolumeProfileResult {
  if (page.bins.length === 0) {
    return { bins: [], pocPrice: null, vahPrice: null, valPrice: null, maxBinVol: 0, totalVol: 0 };
  }
  const step = page.bins.length > 1 ? Math.max(1, page.bins[1]!.price - page.bins[0]!.price) : 1;
  let maxBinVol = 0;
  let totalVol = 0;
  const bins: VolumeProfileBinView[] = page.bins.map((b) => {
    totalVol += b.totalVol;
    if (b.totalVol > maxBinVol) maxBinVol = b.totalVol;
    return {
      low: b.price,
      high: b.price + step,
      mid: b.price + step / 2,
      buyVol: b.buyVol,
      sellVol: b.sellVol,
      totalVol: b.totalVol,
    };
  });
  return {
    bins,
    pocPrice: page.pocPrice ?? null,
    vahPrice: page.vahPrice ?? null,
    valPrice: page.valPrice ?? null,
    maxBinVol,
    totalVol,
  };
}
