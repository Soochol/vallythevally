const WITHOUT_FINAL_CONSONANT_RO = new Set([1, 2, 4, 5, 7, 8, 9]);

export function withDirectionJosa(quantity: number): string {
  const text = quantity.toLocaleString("ko-KR");
  const lastDigit = Math.abs(quantity) % 10;
  return `${text}${WITHOUT_FINAL_CONSONANT_RO.has(lastDigit) ? "로" : "으로"}`;
}
