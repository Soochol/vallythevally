export const STEP_COUNT = 4;

export function progressOf(scrollTop: number, pinTop: number, pinHeight: number, viewportHeight: number): number {
  const range = pinHeight - viewportHeight;
  if (range <= 0) return 0;
  return Math.min(1, Math.max(0, (scrollTop - pinTop) / range));
}

export function stepOf(progress: number): number {
  return Math.min(STEP_COUNT, Math.floor(progress * STEP_COUNT) + 1);
}
