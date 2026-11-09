import type { SaveTarget } from "../stores/persist";
import type { SaveState } from "./saver";

export type SaveIndicator =
  | { kind: "hidden" }
  | { kind: "busy" }
  | { kind: "saved"; at: number }
  | { kind: "failed" }
  | { kind: "tooLarge"; hint: string | null };

const TOO_LARGE_HINT: Record<SaveTarget, string | null> = {
  layout: "지표나 비교 종목을 줄이세요",
  ui: null,
  watchlist: null,
};

const TARGETS = ["layout", "ui", "watchlist"] as const satisfies readonly SaveTarget[];

export function saveIndicator(saves: Record<SaveTarget, SaveState>, drawing: SaveState = { kind: "idle" }): SaveIndicator {
  if (drawing.kind === "failed" && drawing.reason === "too_large") return { kind: "tooLarge", hint: "드로잉의 점이나 글자를 줄이세요" };
  const tooLarge = TARGETS.find((t) => {
    const s = saves[t];
    return s.kind === "failed" && s.reason === "too_large";
  });
  if (tooLarge) return { kind: "tooLarge", hint: TOO_LARGE_HINT[tooLarge] };
  const states = [...TARGETS.map((t) => saves[t]), drawing];
  if (states.some((s) => s.kind === "failed")) return { kind: "failed" };
  if (states.some((s) => s.kind === "pending" || s.kind === "saving")) return { kind: "busy" };
  const at = Math.max(...states.map((s) => (s.kind === "saved" ? s.at : -Infinity)));
  return at === -Infinity ? { kind: "hidden" } : { kind: "saved", at };
}
