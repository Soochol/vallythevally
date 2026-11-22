import type { HeatmapFlowSeries } from "../api/generated/HeatmapFlowSeries";
import { isPublicMode } from "./serverMode";

export function withNotInThemesMissing(flow: HeatmapFlowSeries): HeatmapFlowSeries {
  if (!isPublicMode() || flow.notInThemes === undefined || flow.notInThemes.length === 0) return flow;
  const { notInThemes, ...rest } = flow;
  return { ...rest, missing: [...new Set([...flow.missing, ...notInThemes])] };
}
