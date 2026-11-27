export function krxTickSize(price: number, isEtf = false): number {
  const p = Math.max(1, Math.floor(price));
  if (isEtf) return p < 2_000 ? 1 : 5;
  if (p < 2_000) return 1;
  if (p < 5_000) return 5;
  if (p < 20_000) return 10;
  if (p < 50_000) return 50;
  if (p < 200_000) return 100;
  if (p < 500_000) return 500;
  return 1_000;
}

export function snapKrxPrice(price: number, isEtf = false): number {
  const clamped = Math.max(1, price);
  const step = krxTickSize(clamped, isEtf);
  return Math.max(step, Math.round(clamped / step) * step);
}
