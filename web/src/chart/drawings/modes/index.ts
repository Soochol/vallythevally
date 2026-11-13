import type { ModeId } from "../gestures";
import type { RenderItem } from "../frame";
import type { Shape, ToolContext } from "../toolSpec";
import type { DrawingOp, DrawingScope, ScreenPoint } from "../types";
import { demo } from "./demo";
import { eraser } from "./eraser";

export interface ModeContext {
  ctx: ToolContext;
  items: readonly RenderItem[];
  lockAll: boolean;
  panesBottom: number;
  scope: DrawingScope;
  newId(): string;
}
export interface TransientShapes { shapes: readonly Shape[]; holdMs: number; fadeMs: number }
export interface ModeSpec {
  id: ModeId;
  label: string;
  icon: string;
  preview(path: readonly ScreenPoint[], ctx: ModeContext): readonly Shape[];
  finish(path: readonly ScreenPoint[], partial: boolean, ctx: ModeContext): { ops: readonly DrawingOp[]; transient?: TransientShapes };
}
export const MODES: readonly ModeSpec[] = [eraser, demo];
export const modeOf = (id: ModeId) => MODES.find((mode) => mode.id === id);
export const registeredModes = () => new Set(MODES.map((mode) => mode.id));
