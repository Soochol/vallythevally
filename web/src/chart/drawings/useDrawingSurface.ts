import { useQueryClient } from "@tanstack/react-query";
import { useEffect, type RefObject } from "react";
import type { ChartController } from "../ChartController";
import { useCell } from "../../stores/layout";
import { useDrawingSession } from "../../stores/drawingSession";
import { drawingSync } from "./sync";
import { layoutReceipt } from "../../persist/layoutReceipt";
import { DrawingSurface, surfaceFor } from "./DrawingSurface";
import type { WindowId } from "../../layout/kinds";

export function useDrawingSurface(controller: RefObject<ChartController | null>, cellId: WindowId) {
  const client = useQueryClient(); const cell = useCell(cellId);
  useEffect(() => controller.current?.attach((host) => new DrawingSurface(host, cellId, drawingSync(client, layoutReceipt))), [controller, cellId, client]);
  useEffect(() => {
    useDrawingSession.getState().select([]); surfaceFor(cellId)?.reset();
    void drawingSync(client, layoutReceipt).load(cell.symbol);
  }, [cell.symbol, cell.period, cellId, client]);
}
