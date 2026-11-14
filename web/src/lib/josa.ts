const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const HANGUL_RIEUL = 8;

export type FinalConsonant = "none" | "rieul" | "other";

const DIGIT_FINAL: readonly FinalConsonant[] = ["other", "rieul", "none", "other", "none", "none", "other", "rieul", "rieul", "none"];
const LETTER_FINAL: Readonly<Record<string, FinalConsonant>> = { L: "rieul", M: "other", N: "other", R: "rieul" };

export function finalConsonant(word: string): FinalConsonant {
  const bare = word.endsWith(")") ? word.slice(0, word.lastIndexOf("(")) : word;
  const last = bare.at(-1) ?? "";
  const code = last.charCodeAt(0);
  if (code >= HANGUL_FIRST && code <= HANGUL_LAST) {
    const final = (code - HANGUL_FIRST) % 28;
    return final === 0 ? "none" : final === HANGUL_RIEUL ? "rieul" : "other";
  }
  if (last >= "0" && last <= "9") return DIGIT_FINAL[Number(last)]!;
  return LETTER_FINAL[last.toUpperCase()] ?? "none";
}

export const endsWithFinalConsonant = (word: string): boolean => finalConsonant(word) !== "none";

export const toward = (word: string): string => `${word}${finalConsonant(word) === "other" ? "으로" : "로"}`;
