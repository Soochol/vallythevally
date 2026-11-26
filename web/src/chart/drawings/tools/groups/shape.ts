import type { Tool } from "../../toolSpec";
import { brush } from "../brush";
import { curve } from "../curve";
import { ellipse } from "../ellipse";
import { highlighter } from "../highlighter";
import { path } from "../path";
import { rect } from "../rect";
import { triangle } from "../triangle";

export const SHAPE_TOOLS: readonly Tool[] = [
  rect,
  ellipse,
  triangle,
  curve,
  path,
  brush,
  highlighter,
];
