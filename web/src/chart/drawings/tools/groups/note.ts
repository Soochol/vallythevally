import type { Tool } from "../../toolSpec";
import { arrow } from "../arrow";
import { callout } from "../callout";
import { pricelabel } from "../pricelabel";
import { text } from "../text";

export const NOTE_TOOLS: readonly Tool[] = [
  text,
  callout,
  pricelabel,
  arrow,
];
