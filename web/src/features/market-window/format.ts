import { formatDecimal, MINUS } from "../../lib/format";

export { formatKstClockSeconds as formatClock } from "../../chart/time";

const whole = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const twoDecimals = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatQuantity = (quantity: number): string => whole.format(quantity);

export const formatShares = (shares: number): string => `${whole.format(shares)}주`;

export const formatWon = (won: number): string => `${whole.format(won)}원`;

export const formatEokWon = (won: number): string => `${twoDecimals.format(won / 1e8)}억원`;

export const withSign = (value: number, formatted: string): string => (value > 0 ? "+" : value < 0 ? MINUS : "") + formatted;

export const formatStrength = (strength: number | null): string => (strength === null ? "—" : `${formatDecimal(strength)}%`);
