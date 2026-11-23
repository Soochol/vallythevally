export const THEME_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)"] as const;

export function themeColors(ids: readonly string[]): Map<string, string> {
  const ranked = [...new Set(ids)].sort();
  return new Map(ranked.map((id, i) => [id, THEME_COLORS[i % THEME_COLORS.length] ?? THEME_COLORS[0]] as const));
}
