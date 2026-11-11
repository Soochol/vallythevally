import type { Day, FredSeries } from "./bundle-types.ts";
import { day, endpoint, getText, type HttpClient } from "./source-utils.ts";

export const FRED_SERIES: Array<{ id: string; unit: FredSeries["unit"]; frequency: FredSeries["frequency"] }> = [
  { id: "DEXKOUS", unit: "KRW/USD", frequency: "daily" },
  { id: "IRLTLT01KRM156N", unit: "percent", frequency: "monthly" },
  { id: "DGS10", unit: "percent", frequency: "daily" },
  { id: "DGS2", unit: "percent", frequency: "daily" },
  { id: "DFF", unit: "percent", frequency: "daily" },
];
export function parseFredCsv(csv: string, id: string): FredSeries["observations"] {
  const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const header = lines.shift();
  if (header !== `observation_date,${id}` && header !== `DATE,${id}`) throw new Error("fred_invalid_header");
  const result = lines.filter((line) => line !== "").map((line) => {
    const cells = line.split(",");
    if (cells.length !== 2) throw new Error("fred_invalid_row");
    const date = day(cells[0]);
    const value = cells[1] === "" || cells[1] === "." ? null : /^[-+]?\d+(?:\.\d+)?$/.test(cells[1]!) ? Number(cells[1]) : NaN;
    if (value !== null && !Number.isFinite(value)) throw new Error("fred_invalid_value");
    return { day: date, value };
  });
  if (result.length === 0 || result.some((r, i) => i > 0 && r.day <= result[i - 1]!.day)) throw new Error("fred_invalid_order_or_empty");
  return result;
}
export function alignFred(observations: FredSeries["observations"], calendar: Day[], frequency: FredSeries["frequency"]): FredSeries["aligned"] {
  let cursor = 0;
  let latest: FredSeries["observations"][number] | undefined;
  return calendar.map((date) => {
    while (cursor < observations.length) {
      const observation = observations[cursor]!;
      const eligibleAfter = frequency === "monthly" ? day(new Date(Date.UTC(Number(observation.day.slice(0, 4)), Number(observation.day.slice(5, 7)), 0)).toISOString().slice(0, 10)) : observation.day;
      if (eligibleAfter >= date) break;
      if (observation.value !== null) latest = observation;
      cursor++;
    }
    return { day: date, sourceDay: latest?.day ?? null, value: latest?.value ?? null, reason: latest ? null : "no_strictly_earlier_observation" };
  });
}
export async function readFred(args: { base: URL; definition: (typeof FRED_SERIES)[number]; to: Day; calendar: Day[]; client: HttpClient }): Promise<FredSeries> {
  const { base, definition, to, calendar, client } = args;
  const csv = await getText(client, endpoint(base, "/graph/fredgraph.csv", { id: definition.id, coed: to }));
  const observations = parseFredCsv(csv, definition.id).filter((o) => o.day <= to);
  return { ...definition, observations, aligned: alignFred(observations, calendar, definition.frequency), vintage: "latest-download" };
}
