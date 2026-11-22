export const THEME_COLORS = ["#C7F36B", "#5ED4E8", "#E88AE0", "#EBC074", "#B9A6FF", "#F59047", "#64F7DE", "#DEBDBA"] as const;

export function themeColors(ids: readonly string[]): Map<string, string> {
  const ranked = [...new Set(ids)].sort();
  return new Map(ranked.map((id, i) => [id, THEME_COLORS[i % THEME_COLORS.length] ?? THEME_COLORS[0]] as const));
}
