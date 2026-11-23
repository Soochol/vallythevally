import { isMarketOpen } from "../../chart/time";
import { assessDataAge, type DataCadence } from "../../lib/dataAge";
import { useServerTime } from "../status/useServerTime";
import "./dataAge.css";

export const STALE_NOTE = "자료가 늦어지고 있습니다";

interface Props {
  recordedAt: number | null;
  cadence: DataCadence;
  live?: boolean;
}

export function DataAgeNote({ recordedAt, cadence, live }: Props) {
  const now = useServerTime();
  const { label, stale } = assessDataAge(recordedAt, now, cadence, live ?? isMarketOpen(now));
  if (label === null) return null;
  return (
    <span className="data-age" data-testid="data-age" data-stale={stale}>
      {label}
      {stale && ` · ${STALE_NOTE}`}
    </span>
  );
}
