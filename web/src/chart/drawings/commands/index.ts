import type { DrawingSurface } from "../DrawingSurface";
import type { DrawingBody } from "../types";

export interface DrawingCommand {
  id: string;
  label: string;
  available(selected: readonly DrawingBody[]): boolean;
  run(surface: DrawingSurface): void;
}
export const DRAWING_COMMANDS: readonly DrawingCommand[] = [];
