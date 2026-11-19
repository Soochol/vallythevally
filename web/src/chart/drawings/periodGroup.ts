import type { Period } from "../../api/generated/Period";
import { isMinutePeriod, PERIODS } from "../../lib/symbol";

export const periodGroup = (period: Period): Period[] => PERIODS.filter((p) => isMinutePeriod(p) === isMinutePeriod(period));
