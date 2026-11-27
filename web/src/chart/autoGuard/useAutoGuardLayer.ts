import { useEffect, type RefObject } from "react";
import type { ChartController } from "../ChartController";
import { createAutoGuardLayer } from "./AutoGuardLayer";

export function useAutoGuardLayer(ctl: RefObject<ChartController | null>): void {
  useEffect(() => {
    const controller = ctl.current;
    if (!controller) return;
    return controller.attach(createAutoGuardLayer);
  }, [ctl]);
}
