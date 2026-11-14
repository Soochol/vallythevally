import type { Tool } from "../../toolSpec";
import { brush } from "../brush";
import { ellipse } from "../ellipse";
import { path } from "../path";
import { rect } from "../rect";
import { triangle } from "../triangle";

export const SHAPE_TOOLS: readonly Tool[] = [
  rect,
  ellipse,
  triangle,
  path,
  brush,
];
