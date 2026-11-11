import { fileURLToPath } from "node:url";
import { readSectorMap, SectorMapError } from "./sector-map.ts";
import type { SectorMap, SectorStock } from "./sector-map.ts";

const USAGE = "쓰는 법: node check-sector-symbols.ts <서버 주소, 예: http://127.0.0.1:8080> [섹터 지도 경로]";
const DEFAULT_MAP_PATH = fileURLToPath(new URL("./sectors.json", import.meta.url));
const REQUEST_TIMEOUT_MS = 10_000;

type Lookup = { kind: "found"; name: string } | { kind: "missing" } | { kind: "unchecked"; why: string };

interface Checked {
  sectorId: string;
  stock: SectorStock;
  lookup: Lookup;
}

async function lookUp(server: URL, code: string): Promise<Lookup> {
  let res: Response;
  try {
    res = await fetch(new URL(`/api/symbols/${encodeURIComponent(code)}`, server), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    return { kind: "unchecked", why: e instanceof Error ? `${e.message}${e.cause instanceof Error ? ` (${e.cause.message})` : ""}` : String(e) };
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok && typeof body === "object" && body !== null && "name" in body && typeof body.name === "string") return { kind: "found", name: body.name };
  if (res.status === 404 && errorCodeOf(body) === "unknown_symbol") return { kind: "missing" };
  return { kind: "unchecked", why: `HTTP ${res.status} ${errorCodeOf(body) ?? "알 수 없는 응답"}` };
}

function errorCodeOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const error = body.error;
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function checkAll(map: SectorMap, server: URL): Promise<Checked[]> {
  const checked: Checked[] = [];
  for (const sector of map.sectors) {
    for (const stock of sector.stocks) checked.push({ sectorId: sector.id, stock, lookup: await lookUp(server, stock.code) });
  }
  return checked;
}

function report(checked: Checked[]): { lines: string[]; passed: boolean } {
  const label = (c: Checked) => `${c.stock.code} ${c.stock.name} (${c.sectorId})`;
  const found = checked.filter((c) => c.lookup.kind === "found");
  const renamed = found.flatMap((c) => (c.lookup.kind === "found" && c.lookup.name !== c.stock.name ? [{ c, serverName: c.lookup.name }] : []));
  const missing = checked.filter((c) => c.lookup.kind === "missing");
  const unchecked = checked.flatMap((c) => (c.lookup.kind === "unchecked" ? [{ c, why: c.lookup.why }] : []));
  const lines = [
    `있음 ${found.length}개, 없음 ${missing.length}개, 이름 다름 ${renamed.length}개, 확인 못 함 ${unchecked.length}개`,
    ...missing.map((c) => `없음: ${label(c)}`),
    ...renamed.map(({ c, serverName }) => `이름 다름: ${label(c)} → 서버 이름 ${serverName}`),
    ...unchecked.map(({ c, why }) => `확인 못 함: ${label(c)}: ${why}`),
  ];
  return { lines, passed: missing.length === 0 && renamed.length === 0 && unchecked.length === 0 };
}

function parseServer(arg: string): URL | undefined {
  try {
    const url = new URL(arg);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

async function main(args: string[]): Promise<number> {
  const server = args.length >= 1 && args.length <= 2 ? parseServer(args[0]!) : undefined;
  if (server === undefined) {
    console.error(USAGE);
    return 2;
  }
  const mapPath = args[1] ?? DEFAULT_MAP_PATH;
  let map: SectorMap;
  try {
    map = await readSectorMap(mapPath);
  } catch (e) {
    console.error(e instanceof SectorMapError ? e.message : `섹터 지도를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const stockCount = map.sectors.reduce((n, s) => n + s.stocks.length, 0);
  console.log(`섹터 지도 ${mapPath}: 섹터 ${map.sectors.length}개, 종목 ${stockCount}개를 ${server.origin} 종목 목록과 견줍니다`);
  const { lines, passed } = report(await checkAll(map, server));
  for (const line of lines) console.log(line);
  return passed ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
