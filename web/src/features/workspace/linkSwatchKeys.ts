import type { LinkColor } from "../../api/generated/LinkColor";
import { LINK_COLORS } from "../../api/linkColors";

export const SWATCH_COUNT = LINK_COLORS.length + 1;
const ROW_LENGTH = LINK_COLORS.length / 2;
const FIRST_COLOR = 1;
const LAST_INDEX = SWATCH_COUNT - 1;

export function swatchIndexOfLink(link: LinkColor | null): number {
  return link === null ? 0 : LINK_COLORS.indexOf(link) + FIRST_COLOR;
}

export function swatchLinkAt(index: number): LinkColor | null {
  return LINK_COLORS[index - FIRST_COLOR] ?? null;
}

export function swatchIndexAfterKey(index: number, key: string): number | null {
  const inFirstRow = index >= FIRST_COLOR && index < FIRST_COLOR + ROW_LENGTH;
  const inSecondRow = index >= FIRST_COLOR + ROW_LENGTH;
  switch (key) {
    case "ArrowRight": return Math.min(index + 1, LAST_INDEX);
    case "ArrowLeft": return Math.max(index - 1, 0);
    case "ArrowDown": return inFirstRow ? index + ROW_LENGTH : index;
    case "ArrowUp": return inSecondRow ? index - ROW_LENGTH : index;
    case "Home": return 0;
    case "End": return LAST_INDEX;
  }
  const letter = LINK_COLORS.find((link) => link === key.toLowerCase());
  return key.length === 1 && letter !== undefined ? swatchIndexOfLink(letter) : null;
}
