import type { Tool } from "../../toolSpec";
import { fib } from "../fib";
import { fibext } from "../fibext";
import { fibfan } from "../fibfan";
import { fibtime } from "../fibtime";
import { gannbox } from "../gannbox";
import { gannfan } from "../gannfan";

export const FIB_TOOLS: readonly Tool[] = [
  fib,
  fibext,
  fibfan,
  fibtime,
  gannfan,
  gannbox,
];
