import { MINUS } from "../../lib/format";
import { formatClock, formatQuantity, withSign } from "../market-window/format";
import { eventsUntil, type BrokerTrack } from "./board";

const signed = (value: number) => withSign(value, formatQuantity(Math.abs(value)).replace("-", MINUS));

export function DetailTable({ track }: { track: BrokerTrack }) {
  const rows = eventsUntil(track, null, track.events.length);
  return (
    <div className="br-det" data-testid="broker-detail">
      <table>
        <caption>{track.name}</caption>
        <thead>
          <tr>
            <th>시각</th>
            <th>순간</th>
            <th>누적 순매수</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((event) => (
            <tr key={event.t} data-testid="broker-detail-row">
              <td>{formatClock(event.t)}</td>
              <td data-tone={event.net >= 0 ? "up" : "down"}>{signed(event.net)}</td>
              <td data-tone={event.cumulative >= 0 ? "up" : "down"}>{signed(event.cumulative)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
