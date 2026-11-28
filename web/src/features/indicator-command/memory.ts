import type { IndicatorKind } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";

const remembered = new Map<string, IndicatorConfig[]>();

const keyOf = (cellId: WindowId, kind: IndicatorKind): string => `${cellId}:${kind}`;

export function rememberRemoved(cellId: WindowId, configs: readonly IndicatorConfig[]): void {
  const byKind = new Map<IndicatorKind, IndicatorConfig[]>();
  for (const config of configs) {
    const list = byKind.get(config.spec.kind);
    if (list) list.push(structuredClone(config));
    else byKind.set(config.spec.kind, [structuredClone(config)]);
  }
  for (const [kind, list] of byKind) remembered.set(keyOf(cellId, kind), list);
}

export function rememberedOf(cellId: WindowId, kind: IndicatorKind): readonly IndicatorConfig[] {
  return remembered.get(keyOf(cellId, kind)) ?? [];
}

export function forgetRemembered(cellId: WindowId, kind: IndicatorKind): void {
  remembered.delete(keyOf(cellId, kind));
}

export function clearIndicatorMemory(): void {
  remembered.clear();
}
