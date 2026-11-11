import { readFile } from "node:fs/promises";

export const SECTOR_COVERAGES = ["top-market-cap", "all-peers"] as const;
export type SectorCoverage = (typeof SECTOR_COVERAGES)[number];

export const TOP_MARKET_CAP_SIZE = { min: 3, max: 10 } as const;

export interface SectorStock {
  code: string;
  name: string;
  reason: string;
}

export interface Sector {
  id: string;
  name: string;
  scope: string;
  coverage: SectorCoverage;
  stocks: SectorStock[];
}

export interface ExcludedStock {
  code: string;
  name: string;
  sector: string;
  reason: string;
}

export interface SectorMap {
  asOf: string;
  sectors: Sector[];
  excluded: ExcludedStock[];
}

export class SectorMapError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`섹터 지도에 문제가 ${problems.length}개 있습니다:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    this.name = "SectorMapError";
    this.problems = problems;
  }
}

const STOCK_CODE = /^[0-9A-Z]{6}$/;
const SECTOR_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCoverage(value: unknown): value is SectorCoverage {
  return SECTOR_COVERAGES.some((c) => c === value);
}

class Problems {
  readonly found: string[] = [];

  add(problem: string): void {
    this.found.push(problem);
  }

  text(fields: Fields, key: string, at: string): string {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") return value;
    this.add(`${at}: ${key}가 비었습니다`);
    return "";
  }

  code(fields: Fields, at: string): string {
    const value = fields.code;
    if (typeof value === "string" && STOCK_CODE.test(value)) return value;
    this.add(`${at}: 종목코드 ${JSON.stringify(value)}는 영문 대문자·숫자 6자리가 아닙니다`);
    return "";
  }

  list(fields: Fields, key: string, at: string): unknown[] {
    const value = fields[key];
    if (Array.isArray(value)) return value;
    this.add(`${at}: ${key}가 배열이 아닙니다`);
    return [];
  }

  objects(items: unknown[], at: string): Array<{ fields: Fields; at: string }> {
    return items.flatMap((item, i) => {
      if (isFields(item)) return [{ fields: item, at: `${at}[${i}]` }];
      this.add(`${at}[${i}]가 객체가 아닙니다`);
      return [];
    });
  }
}

export function parseSectorMap(raw: unknown): SectorMap {
  if (!isFields(raw)) throw new SectorMapError(["맨 위가 객체가 아닙니다"]);
  const problems = new Problems();
  const asOf = problems.text(raw, "asOf", "지도");
  if (asOf !== "" && !ISO_DATE.test(asOf)) problems.add(`지도: asOf ${asOf}는 YYYY-MM-DD가 아닙니다`);
  const sectors = problems.objects(problems.list(raw, "sectors", "지도"), "sectors").map((s) => parseSector(s.fields, s.at, problems));
  const excluded = problems.objects(problems.list(raw, "excluded", "지도"), "excluded").map((e) => parseExcluded(e.fields, e.at, problems));
  checkMembership(sectors, excluded, problems);
  if (problems.found.length > 0) throw new SectorMapError(problems.found);
  return { asOf, sectors, excluded };
}

function parseSector(fields: Fields, at: string, problems: Problems): Sector {
  const id = problems.text(fields, "id", at);
  if (id !== "" && !SECTOR_ID.test(id)) problems.add(`${at}: id ${id}는 영어 소문자와 하이픈이 아닙니다`);
  const where = id || at;
  const name = problems.text(fields, "name", where);
  const scope = problems.text(fields, "scope", where);
  const coverage = isCoverage(fields.coverage) ? fields.coverage : "top-market-cap";
  if (!isCoverage(fields.coverage)) problems.add(`${where}: coverage는 ${SECTOR_COVERAGES.join(" 또는 ")}입니다`);
  const stocks = problems.objects(problems.list(fields, "stocks", where), `${where}.stocks`).map((s) => ({
    code: problems.code(s.fields, s.at),
    name: problems.text(s.fields, "name", s.at),
    reason: problems.text(s.fields, "reason", s.at),
  }));
  const { min, max } = TOP_MARKET_CAP_SIZE;
  if (coverage === "top-market-cap" && (stocks.length < min || stocks.length > max)) problems.add(`${where}: 시가총액 상위 섹터는 ${min}~${max}종목인데 ${stocks.length}종목입니다`);
  if (coverage === "all-peers" && stocks.length < min) problems.add(`${where}: 동종 전부 섹터도 ${min}종목 이상인데 ${stocks.length}종목입니다`);
  return { id, name, scope, coverage, stocks };
}

function parseExcluded(fields: Fields, at: string, problems: Problems): ExcludedStock {
  return {
    code: problems.code(fields, at),
    name: problems.text(fields, "name", at),
    sector: problems.text(fields, "sector", at),
    reason: problems.text(fields, "reason", at),
  };
}

function checkMembership(sectors: Sector[], excluded: ExcludedStock[], problems: Problems): void {
  const sectorIds = new Set<string>();
  for (const sector of sectors) {
    if (sectorIds.has(sector.id)) problems.add(`섹터 id ${sector.id}가 두 번 나옵니다`);
    sectorIds.add(sector.id);
  }
  const sectorOfCode = new Map<string, string>();
  for (const sector of sectors) {
    for (const stock of sector.stocks.filter((s) => s.code !== "")) {
      const earlier = sectorOfCode.get(stock.code);
      if (earlier === undefined) sectorOfCode.set(stock.code, sector.id);
      else problems.add(`종목 ${stock.code} ${stock.name}이 섹터 ${earlier}와 ${sector.id}에 함께 있습니다. 한 종목은 섹터 하나에만 듭니다`);
    }
  }
  for (const entry of excluded) {
    const listedIn = sectorOfCode.get(entry.code);
    if (listedIn !== undefined) problems.add(`넣지 못한 종목 ${entry.code} ${entry.name}이 섹터 ${listedIn}에도 있습니다`);
    if (!sectorIds.has(entry.sector)) problems.add(`넣지 못한 종목 ${entry.code} ${entry.name}의 섹터 ${entry.sector}가 지도에 없습니다`);
  }
}

export async function readSectorMap(path: string): Promise<SectorMap> {
  const text = await readFile(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new SectorMapError([`${path}가 JSON이 아닙니다: ${e instanceof Error ? e.message : String(e)}`]);
  }
  return parseSectorMap(raw);
}
