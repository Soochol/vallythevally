import type { Tool } from "../../toolSpec";
import { hline } from "../hline";
import { trendline } from "../trendline";

export const LINE_TOOLS: readonly Tool[] = [
  trendline,
  hline,
];
