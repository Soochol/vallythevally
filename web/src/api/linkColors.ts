import type { LinkColor } from "./generated/LinkColor";

const LINK_COLOR_SET: Record<LinkColor, true> = { a: true, b: true, c: true, d: true, e: true, f: true, g: true, h: true, i: true, j: true };

export const LINK_COLORS = Object.keys(LINK_COLOR_SET) as LinkColor[];
