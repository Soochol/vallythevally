import type { Tool } from "../../toolSpec";
import { elliott, elliottabc } from "../elliott";
import { headshoulders } from "../headshoulders";
import { xabcd } from "../xabcd";

export const PATTERN_TOOLS: readonly Tool[] = [
  elliott,
  elliottabc,
  xabcd,
  headshoulders,
];
