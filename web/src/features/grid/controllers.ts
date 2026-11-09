import type { ChartController } from "../../chart/ChartController";
import type { Slot } from "../../stores/layout";

const bySlot = new Map<Slot, ChartController>();

export function attachController(slot: Slot, controller: ChartController): () => void {
  bySlot.set(slot, controller);
  return () => {
    if (bySlot.get(slot) === controller) bySlot.delete(slot);
  };
}

export function controllerFor(slot: Slot): ChartController | undefined {
  return bySlot.get(slot);
}
