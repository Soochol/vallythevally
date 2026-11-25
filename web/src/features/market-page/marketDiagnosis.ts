import type { MarketOverviewIndex } from "../../api/generated/MarketOverviewIndex";
import { signedRate } from "./marketFormat";

export type MarketDiagnosisKind = "jointBull" | "kospiLead" | "kosdaqLead" | "jointBear" | "mixed";
export type MarketDiagnosisTone = "up" | "down" | "flat";

export interface HealthAxis {
  id: "return" | "breadth" | "leadership" | "volatility" | "balance";
  label: string;
  score: number;
}

export interface MarketDiagnosis {
  kind: MarketDiagnosisKind;
  badge: string;
  summary: string;
  tone: MarketDiagnosisTone;
  axes: readonly HealthAxis[];
  overallScore: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const roundScore = (value: number): number => Math.round(clamp(value, 5, 98));

function breadthRatioOf(indices: readonly MarketOverviewIndex[]): number | null {
  let rising = 0;
  let falling = 0;
  let hasData = false;
  for (const item of indices) {
    if (item.breadth.rising !== null || item.breadth.falling !== null) {
      rising += item.breadth.rising ?? 0;
      falling += item.breadth.falling ?? 0;
      hasData = true;
    }
  }
  if (!hasData || rising + falling === 0) return null;
  return rising / (rising + falling);
}

function limitNetOf(indices: readonly MarketOverviewIndex[]): number | null {
  let upper = 0;
  let lower = 0;
  let hasData = false;
  for (const item of indices) {
    if (item.breadth.upperLimit !== null || item.breadth.lowerLimit !== null) {
      upper += item.breadth.upperLimit ?? 0;
      lower += item.breadth.lowerLimit ?? 0;
      hasData = true;
    }
  }
  return hasData ? upper - lower : null;
}

function computeAxes(kospi: MarketOverviewIndex | null, kosdaq: MarketOverviewIndex | null): readonly HealthAxis[] {
  const present = [kospi, kosdaq].filter((item): item is MarketOverviewIndex => item !== null);
  const avgRate = present.reduce((sum, item) => sum + item.changeRate, 0) / Math.max(present.length, 1);
  const returnScore = roundScore(50 + avgRate * 25);

  const breadthRatio = breadthRatioOf(present);
  const breadthScore = breadthRatio === null ? 50 : roundScore(breadthRatio * 100);

  const limitNet = limitNetOf(present);
  const leadershipBase = breadthRatio === null ? 50 : breadthRatio * 80 + 10;
  const leadershipScore = roundScore(leadershipBase + (limitNet === null ? 0 : clamp(limitNet * 3, -18, 18)));

  const vkospi = kospi?.volatility?.level ?? null;
  const volatilityScore = vkospi === null ? 60 : roundScore(100 - (vkospi - 12) * 3.5);

  const spread = kospi !== null && kosdaq !== null ? Math.abs(kospi.changeRate - kosdaq.changeRate) : 0;
  const balanceScore = roundScore(100 - Math.min(90, spread * 35));

  return [
    { id: "return", label: "수익률", score: returnScore },
    { id: "breadth", label: "등락폭", score: breadthScore },
    { id: "leadership", label: "주도력", score: leadershipScore },
    { id: "volatility", label: "안정성", score: volatilityScore },
    { id: "balance", label: "균형", score: balanceScore },
  ];
}

export function diagnoseMarket(kospi: MarketOverviewIndex | null, kosdaq: MarketOverviewIndex | null): MarketDiagnosis | null {
  if (kospi === null && kosdaq === null) return null;
  const axes = computeAxes(kospi, kosdaq);
  const overallScore = Math.round(axes.reduce((sum, axis) => sum + axis.score, 0) / axes.length);

  if (kospi !== null && kosdaq !== null) {
    const kp = kospi.changeRate;
    const kd = kosdaq.changeRate;
    const gap = kp - kd;
    const breadthRatio = breadthRatioOf([kospi, kosdaq]);
    const breadthText = breadthRatio === null ? "" : ` · 상승 비중 ${Math.round(breadthRatio * 100)}%`;

    if (kp >= 0.25 && kd >= 0.25) {
      return {
        kind: "jointBull",
        badge: "동반 강세",
        summary: `코스피 ${signedRate(kp)} · 코스닥 ${signedRate(kd)} 양 시장 동반 상승${breadthText}`,
        tone: "up",
        axes,
        overallScore,
      };
    }
    if (kp <= -0.25 && kd <= -0.25) {
      return {
        kind: "jointBear",
        badge: "동반 약세",
        summary: `코스피 ${signedRate(kp)} · 코스닥 ${signedRate(kd)} 양 시장 동반 하락${breadthText}`,
        tone: "down",
        axes,
        overallScore,
      };
    }
    if (kp >= 0.2 && gap >= 0.5) {
      return {
        kind: "kospiLead",
        badge: "디커플링 · 코스피 쏠림",
        summary: `코스피 ${signedRate(kp)} 강세 대비 코스닥 ${signedRate(kd)} 부진${breadthText}`,
        tone: "up",
        axes,
        overallScore,
      };
    }
    if (kd >= 0.2 && gap <= -0.5) {
      return {
        kind: "kosdaqLead",
        badge: "디커플링 · 코스닥 쏠림",
        summary: `코스닥 ${signedRate(kd)} 강세 대비 코스피 ${signedRate(kp)} 정체${breadthText}`,
        tone: "up",
        axes,
        overallScore,
      };
    }
    return {
      kind: "mixed",
      badge: "보합 탐색",
      summary: `코스피 ${signedRate(kp)} · 코스닥 ${signedRate(kd)} 혼조 흐름${breadthText}`,
      tone: "flat",
      axes,
      overallScore,
    };
  }

  const single = (kospi ?? kosdaq)!;
  const tone: MarketDiagnosisTone = single.changeRate >= 0.25 ? "up" : single.changeRate <= -0.25 ? "down" : "flat";
  return {
    kind: tone === "up" ? "jointBull" : tone === "down" ? "jointBear" : "mixed",
    badge: tone === "up" ? "단독 강세" : tone === "down" ? "단독 약세" : "보합 탐색",
    summary: `${single.name} ${signedRate(single.changeRate)} 흐름`,
    tone,
    axes,
    overallScore,
  };
}
