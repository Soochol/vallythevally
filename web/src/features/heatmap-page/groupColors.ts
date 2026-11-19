export const GROUP_COLORS = ["#C7F36B", "#5ED4E8", "#E88AE0", "#EBC074", "#B9A6FF", "#F59047", "#64F7DE", "#DEBDBA"] as const;

export function groupColor(index: number): string {
  return GROUP_COLORS[index % GROUP_COLORS.length] ?? GROUP_COLORS[0];
}
