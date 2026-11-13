import type { Tool } from "../../toolSpec";
import { fib } from "../fib";
import { fibext } from "../fibext";

export const FIB_TOOLS: readonly Tool[] = [
  fib,
  fibext,
];
