import type { Tool } from "../../toolSpec";
import { anchoredtext } from "../anchoredtext";
import { arrow } from "../arrow";
import { arrowdown, arrowup } from "../arrowmark";
import { callout } from "../callout";
import { pricelabel } from "../pricelabel";
import { pricenote } from "../pricenote";
import { text } from "../text";

export const NOTE_TOOLS: readonly Tool[] = [
  text,
  anchoredtext,
  callout,
  pricelabel,
  pricenote,
  arrow,
  arrowup,
  arrowdown,
];
