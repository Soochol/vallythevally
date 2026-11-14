import type { Tool } from "../../toolSpec";
import { avwap } from "../avwap";
import { datepricerange } from "../datepricerange";
import { daterange } from "../daterange";
import { long, short } from "../position";
import { pricerange } from "../pricerange";
import { volprofile } from "../volprofile";

export const MEASURE_TOOLS: readonly Tool[] = [
  pricerange,
  daterange,
  datepricerange,
  long,
  short,
  avwap,
  volprofile,
];
