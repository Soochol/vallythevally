export function rovingIndex(count: number, current: number, key: string): number | null {
  if (count === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  return null;
}

export function enabledIndexes(disabled: readonly boolean[]): number[] {
  return disabled.flatMap((isDisabled, index) => (isDisabled ? [] : [index]));
}

export function rovingTarget(disabled: readonly boolean[], current: number, key: string): number | null {
  const enabled = enabledIndexes(disabled);
  const position = rovingIndex(enabled.length, Math.max(0, enabled.indexOf(current)), key);
  return position === null ? null : enabled[position]!;
}
