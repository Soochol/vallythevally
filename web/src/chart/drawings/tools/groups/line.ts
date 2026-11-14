import type { Tool } from "../../toolSpec";
import { channel } from "../channel";
import { crossline } from "../crossline";
import { extline } from "../extline";
import { hline } from "../hline";
import { hray } from "../hray";
import { ray } from "../ray";
import { trendline } from "../trendline";
import { vline } from "../vline";

export const LINE_TOOLS: readonly Tool[] = [
  trendline,
  ray,
  extline,
  hline,
  hray,
  vline,
  crossline,
  channel,
];
