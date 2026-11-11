import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseSectorMap, readSectorMap, SectorMapError } from "./sector-map.ts";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "../..");
const BIN_DIR = path.resolve(REPO, process.env.VALLY_E2E_BIN_DIR ?? "target/debug");
const SCRATCH_ROOT = path.join(REPO, "target", "leader-cases-test");
const START_TIMEOUT_MS = 15_000;

class Proc {
  readonly child: ChildProcess;
  private output = "";

  constructor(bin: string, env: Record<string, string>) {
    if (!existsSync(bin)) throw new Error(`${bin}이 없습니다. 먼저 cargo build -p server -p fake-kiwoom`);
    this.child = spawn(bin, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [this.child.stdout!, this.child.stderr!]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => (this.output += chunk));
    }
  }

  async waitFor(pattern: RegExp, what: string): Promise<string> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const match = pattern.exec(this.output);
      if (match) return match[1]!;
      if (this.child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${what}가 뜨지 않았습니다:\n${this.output}`);
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((r) => this.child.once("exit", r));
    this.child.kill("SIGTERM");
    await exited;
  }
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCheck(...args: string[]): Promise<Run> {
  const child = spawn(process.execPath, [path.join(HERE, "check-sector-symbols.ts"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

function stock(code: string, name: string) {
  return { code, name, reason: "시험" };
}

function sectorMap(sectors: Array<{ id: string; stocks: Array<ReturnType<typeof stock>> }>, excluded: unknown[] = []) {
  return {
    asOf: "2026-11-11",
    sectors: sectors.map((s) => ({ id: s.id, name: s.id, scope: "시험", coverage: "top-market-cap", stocks: s.stocks })),
    excluded,
  };
}

async function waitUntilSymbolListSettles(url: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${url}/api/symbols?q=${encodeURIComponent("삼성")}`);
    if (res.status !== 503) return;
  }
  throw new Error("서버가 종목 목록을 받지 못했습니다");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  await new Promise((r) => server.close(r));
  if (typeof address !== "object" || address === null) throw new Error("빈 포트를 찾지 못했습니다");
  return address.port;
}

describe("섹터 지도 모양", () => {
  test("저장소의 sectors.json은 지도 규칙을 지킨다", async () => {
    const map = await readSectorMap(path.join(HERE, "sectors.json"));
    assert.ok(map.sectors.length >= 25);
    const ecoproSector = map.sectors.find((s) => s.stocks.some((st) => st.code === "247540"));
    assert.equal(ecoproSector?.coverage, "all-peers");
  });

  test("한 종목이 두 섹터에 들면 거절한다", () => {
    const raw = sectorMap([
      { id: "a", stocks: [stock("005930", "삼성전자"), stock("000660", "SK하이닉스"), stock("080220", "제주반도체")] },
      { id: "b", stocks: [stock("005930", "삼성전자"), stock("006400", "삼성SDI"), stock("373220", "LG에너지솔루션")] },
    ]);
    assert.throws(() => parseSectorMap(raw), (e: unknown) => e instanceof SectorMapError && e.problems.some((p) => p.includes("005930") && p.includes("a") && p.includes("b")));
  });

  test("시가총액 상위 섹터는 3~10종목만 받고, 동종 전부 섹터는 10종목을 넘어도 받는다", () => {
    const codes = Array.from({ length: 11 }, (_, i) => stock(`9000${String(i).padStart(2, "0")}`, `종목${i}`));
    const tooFew = sectorMap([{ id: "few", stocks: codes.slice(0, 2) }]);
    const tooMany = sectorMap([{ id: "many", stocks: codes }]);
    assert.throws(() => parseSectorMap(tooFew), /few: 시가총액 상위 섹터는 3~10종목인데 2종목/);
    assert.throws(() => parseSectorMap(tooMany), /many: 시가총액 상위 섹터는 3~10종목인데 11종목/);
    const allPeers = { ...tooMany, sectors: tooMany.sectors.map((s) => ({ ...s, coverage: "all-peers" })) };
    assert.equal(parseSectorMap(allPeers).sectors[0]!.stocks.length, 11);
  });

  test("넣지 못한 종목은 지도 안 섹터를 가리켜야 하고 섹터에 함께 들 수 없다", () => {
    const raw = sectorMap([{ id: "ship", stocks: [stock("329180", "HD현대중공업"), stock("042660", "한화오션"), stock("010140", "삼성중공업")] }], [
      { code: "010620", name: "HD현대미포", sector: "nowhere", reason: "합병" },
      { code: "042660", name: "한화오션", sector: "ship", reason: "시험" },
    ]);
    assert.throws(() => parseSectorMap(raw), (e: unknown) => e instanceof SectorMapError && e.problems.length === 2);
  });
});

describe("종목 목록 확인 (fake-kiwoom으로 띄운 서버)", () => {
  let scratch = "";
  let serverUrl = "";
  const procs: Proc[] = [];

  before(async () => {
    await mkdir(SCRATCH_ROOT, { recursive: true });
    scratch = await mkdtemp(path.join(SCRATCH_ROOT, "run-"));
    const fake = new Proc(path.join(BIN_DIR, "fake-kiwoom"), {});
    procs.push(fake);
    const fakeBase = `http://${await fake.waitFor(/fake-kiwoom listening addr=(\S+)/, "가짜 키움")}`;
    const server = new Proc(path.join(BIN_DIR, "vally-server"), {
      VALLY_KIWOOM_APP_KEY: "FAKE-APPKEY-leader-cases",
      VALLY_KIWOOM_APP_SECRET: "FAKE-SECRET-leader-cases",
      VALLY_KIWOOM_BASE_URL: fakeBase,
      VALLY_KIWOOM_WS_URL: `${fakeBase.replace(/^http/, "ws")}/api/dostk/websocket`,
      VALLY_LOCK_PATH: path.join(scratch, "server.lock"),
      VALLY_DB_PATH: path.join(scratch, "vally.db"),
      VALLY_SCREENER_DB_PATH: path.join(scratch, "screener.duckdb"),
      VALLY_SCREENER_UPDATE_ON_START: "off",
      VALLY_TOKEN_PATH: path.join(scratch, "token.json"),
      VALLY_BIND: "127.0.0.1:0",
      VALLY_STATIC_DIR: scratch,
    });
    procs.push(server);
    serverUrl = `http://${await server.waitFor(/포트를 열었습니다 addr=(\S+)/, "vally-server")}`;
    await waitUntilSymbolListSettles(serverUrl);
  });

  after(async () => {
    await Promise.all(procs.map((p) => p.kill()));
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  async function writeMap(name: string, map: unknown): Promise<string> {
    const file = path.join(scratch, name);
    await writeFile(file, JSON.stringify(map));
    return file;
  }

  test("모든 종목이 목록에 있으면 통과한다", async () => {
    const file = await writeMap("present.json", sectorMap([
      { id: "battery-materials", stocks: [stock("247540", "에코프로비엠"), stock("086520", "에코프로"), stock("006400", "삼성SDI")] },
      { id: "others", stocks: [stock("005930", "삼성전자"), stock("035420", "NAVER"), stock("000810", "삼성화재")] },
    ]));
    const run = await runCheck(serverUrl, file);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /있음 6개, 없음 0개, 이름 다름 0개, 확인 못 함 0개/);
  });

  test("없는 종목이 처음과 중간에 있어도 끝까지 확인하고, 없는 코드를 모두 찍고 실패한다", async () => {
    const file = await writeMap("missing.json", sectorMap([
      { id: "first", stocks: [stock("999990", "처음없는종목"), stock("247540", "에코프로비엠"), stock("086520", "에코프로")] },
      { id: "middle", stocks: [stock("005930", "삼성전자"), stock("999980", "중간없는종목"), stock("035420", "NAVER")] },
    ]));
    const run = await runCheck(serverUrl, file);
    assert.equal(run.code, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /있음 4개, 없음 2개, 이름 다름 0개, 확인 못 함 0개/);
    assert.match(run.stdout, /^없음: 999990 처음없는종목 \(first\)$/m);
    assert.match(run.stdout, /^없음: 999980 중간없는종목 \(middle\)$/m);
    assert.doesNotMatch(run.stdout, /없음: (247540|086520|005930|035420)/);
  });

  test("코드는 있지만 이름이 다르면 서버 이름을 찍고 실패한다", async () => {
    const file = await writeMap("renamed.json", sectorMap([
      { id: "battery-materials", stocks: [stock("247540", "에코프로비엠"), stock("086520", "에코프로홀딩스"), stock("006400", "삼성SDI")] },
    ]));
    const run = await runCheck(serverUrl, file);
    assert.equal(run.code, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /^이름 다름: 086520 에코프로홀딩스 \(battery-materials\) → 서버 이름 에코프로$/m);
  });

  test("서버에 닿지 않으면 없음이 아니라 확인 못 함으로 모두 찍고 실패한다", async () => {
    const file = await writeMap("unreachable.json", sectorMap([
      { id: "battery-materials", stocks: [stock("247540", "에코프로비엠"), stock("086520", "에코프로"), stock("006400", "삼성SDI")] },
    ]));
    const run = await runCheck(`http://127.0.0.1:${await freePort()}`, file);
    assert.equal(run.code, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /있음 0개, 없음 0개, 이름 다름 0개, 확인 못 함 3개/);
    for (const code of ["247540", "086520", "006400"]) assert.match(run.stdout, new RegExp(`^확인 못 함: ${code} `, "m"));
  });

  test("저장소 지도를 돌리면 fake-kiwoom에 있는 종목은 통과하고 없는 종목만 찍힌다", async () => {
    const run = await runCheck(serverUrl);
    assert.equal(run.code, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /확인 못 함 0개/);
    assert.doesNotMatch(run.stdout, /^(없음|이름 다름): (247540|086520|005930|006400|035420|000810) /m);
    assert.match(run.stdout, /^없음: 000660 SK하이닉스 \(memory-semiconductors\)$/m);
  });

  test("서버 주소가 없거나 틀리면 쓰는 법을 찍는다", async () => {
    for (const args of [[], ["127.0.0.1:8080"]]) {
      const run = await runCheck(...args);
      assert.equal(run.code, 2);
      assert.match(run.stderr, /쓰는 법/);
    }
  });
});
