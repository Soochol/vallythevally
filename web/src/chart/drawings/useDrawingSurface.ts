import { useQueryClient } from "@tanstack/react-query";
import { useEffect, type RefObject } from "react";
import type { ChartController } from "../ChartController";
import { useCell, type Slot } from "../../stores/layout";
import { useDrawingSession } from "../../stores/drawingSession";
import { drawingSync } from "./sync";
import { DrawingSurface, surfaceFor } from "./DrawingSurface";

export function useDrawingSurface(controller: RefObject<ChartController | null>, slot: Slot) {
  const client = useQueryClient(); const cell = useCell(slot);
  useEffect(() => controller.current?.attach((host) => new DrawingSurface(host, slot, drawingSync(client))), [controller, slot, client]);
  useEffect(() => {
    useDrawingSession.getState().select([]); surfaceFor(slot)?.reset();
    void drawingSync(client).load(cell.symbol);
  }, [cell.symbol, cell.period, slot, client]);
}
