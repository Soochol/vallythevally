import { useMemo } from "react";
import { create } from "zustand";
import type { IndicatorSpec, Placement } from "../../chart/indicators/kinds";
import { addIndicator, setIndicatorPlacement, updateIndicator, type ChartSettings, type IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";

export type Preview = { kind: "add" | "edit"; id: string; panelId: string; spec: IndicatorSpec; style: IndicatorConfig["style"]; placement: Placement };

export const useIndicatorPreview = create<{ current: { cellId: WindowId; preview: Preview } | null; set(cellId: WindowId, preview: Preview | null): void }>()((set) => ({
  current: null,
  set: (cellId, preview) => set({ current: preview ? { cellId, preview } : null }),
}));

export function previewSettings(settings: ChartSettings, preview: Preview | null): ChartSettings {
  if (!preview) return settings;
  if (preview.kind === "edit") return setIndicatorPlacement(updateIndicator(settings, preview.id, { spec: preview.spec, style: preview.style }), preview.id, preview.placement, () => preview.panelId);
  let nextId = 0;
  return addIndicator(settings, preview.spec, preview.style, () => nextId++ === 0 ? preview.id : preview.panelId, preview.placement).settings;
}

export function useShownSettings(cellId: WindowId, saved: ChartSettings): { settings: ChartSettings; preview: Preview | null } {
  const preview = useIndicatorPreview((s) => s.current?.cellId === cellId ? s.current.preview : null);
  const settings = useMemo(() => previewSettings(saved, preview), [saved, preview]);
  return { settings, preview };
}
