import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";

const WEB_DIR = path.resolve(import.meta.dirname, "..");
const BIN_DIR = path.resolve(WEB_DIR, process.env.VALLY_E2E_BIN_DIR ?? "../target/debug");
const STATIC_DIR = path.join(WEB_DIR, "dist");
const START_TIMEOUT_MS = 15_000;

const FAKE_APP_KEY = "FAKE-APPKEY-e2e-7f3a91c2";
const FAKE_APP_SECRET = "FAKE-SECRET-e2e-c0ffee42";

export const DEFAULT_LAYOUT_ID = "01900000-0000-7000-8000-000000000001";

export interface FakeReply {
  apiId: string;
  status: number;
  body: unknown;
}

export interface Fake {
  respondWith(reply: FakeReply): Promise<void>;
  delay(apiId: string, ms: number): Promise<void>;
  rejectToken(token: string): Promise<void>;
  reset(): Promise<void>;
}

export interface App {
  url: string;
  fake: Fake;
  restart(): Promise<void>;
}

class Proc {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  private output = "";
  private waiters: Array<() => void> = [];

  constructor(bin: string, args: string[], env: Record<string, string>) {
    if (!existsSync(bin)) throw new Error(`${bin}이 없습니다. 먼저 cargo build -p server -p fake-kiwoom`);
    this.child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [this.child.stdout!, this.child.stderr!]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        this.output += chunk;
        this.notify();
      });
    }
    this.exited = new Promise((resolve) => this.child.once("exit", () => resolve()));
    void this.exited.then(() => this.notify());
  }

  get log(): string {
    return this.output;
  }

  private notify() {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  async waitFor(pattern: RegExp, what: string): Promise<string> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      const found = pattern.exec(this.output)?.[1];
      if (found !== undefined) return found;
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`${what}: 프로세스가 먼저 끝났습니다(${this.child.exitCode ?? this.child.signalCode}).\n${this.output}`);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${what}: ${START_TIMEOUT_MS}ms 안에 나오지 않았습니다.\n${this.output}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.exited;
  }
}

function fakeClient(base: string): Fake {
  const post = async (route: string, body?: unknown) => {
    const res = await fetch(`${base}/_fake/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status !== 204) throw new Error(`/_fake/${route}: HTTP ${res.status} ${await res.text()}`);
  };
  return {
    respondWith: (reply) => post("respond-with", reply),
    delay: (apiId, ms) => post("delay", { apiId, ms }),
    rejectToken: (token) => post("reject-token", { token }),
    reset: () => post("reset"),
  };
}

function serverEnv(dir: string, fakeBase: string, bind: string): Record<string, string> {
  return {
    VALLY_KIWOOM_APP_KEY: FAKE_APP_KEY,
    VALLY_KIWOOM_APP_SECRET: FAKE_APP_SECRET,
    VALLY_KIWOOM_BASE_URL: fakeBase,
    VALLY_KIWOOM_WS_URL: `${fakeBase.replace(/^http/, "ws")}/api/dostk/websocket`,
    VALLY_LOCK_PATH: path.join(dir, "server.lock"),
    VALLY_DB_PATH: path.join(dir, "vally.db"),
    VALLY_TOKEN_PATH: path.join(dir, "token.json"),
    VALLY_BIND: bind,
    VALLY_STATIC_DIR: STATIC_DIR,
    VALLY_LOG: "debug",
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

export const test = base.extend<{ app: App; bootReplies: FakeReply[] }>({
  bootReplies: [[], { option: true }],

  app: async ({ bootReplies }, use, testInfo) => {
    if (!existsSync(path.join(STATIC_DIR, "index.html"))) throw new Error(`${STATIC_DIR}가 없습니다. 먼저 pnpm build`);
    const dir = await mkdtemp(path.join(tmpdir(), "vally-e2e-"));
    const fake = new Proc(path.join(BIN_DIR, "fake-kiwoom"), [], {});
    const servers: Proc[] = [];
    try {
      const fakeBase = `http://${await fake.waitFor(/fake-kiwoom listening addr=(\S+)/, "가짜 키움")}`;
      const client = fakeClient(fakeBase);
      for (const reply of bootReplies) await client.respondWith(reply);

      const startServer = async (bind: string) => {
        const server = new Proc(path.join(BIN_DIR, "vally-server"), [], serverEnv(dir, fakeBase, bind));
        servers.push(server);
        return server.waitFor(/포트를 열었습니다 addr=(\S+)/, "vally-server");
      };
      const addr = await startServer("127.0.0.1:0");
      const url = `http://${addr}`;
      await waitUntilSymbolListSettles(url);

      await use({
        url,
        fake: client,
        restart: async () => {
          await servers[servers.length - 1]!.kill();
          await startServer(addr);
          await waitUntilSymbolListSettles(url);
        },
      });
    } finally {
      await Promise.all([fake.kill(), ...servers.map((s) => s.kill())]);
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("fake-kiwoom.log", { body: fake.log, contentType: "text/plain" });
        for (const [i, s] of servers.entries()) await testInfo.attach(`vally-server-${i + 1}.log`, { body: s.log, contentType: "text/plain" });
      }
      await rm(dir, { recursive: true, force: true });
    }
  },

  baseURL: async ({ app }, use) => {
    await use(app.url);
  },
});

export { expect };

export const SEARCH_BUTTON_TITLE = "종목 검색 (/ 또는 Ctrl+K)";

export const cell = (page: Page, n = 1): Locator => page.getByRole("region", { name: new RegExp(`^칸 ${n}: `) });

export const chartOf = (c: Locator): Locator => c.locator("[data-bar-count]");

export async function barTimes(chart: Locator): Promise<{ count: number; first: number }> {
  const [count, first] = await Promise.all([chart.getAttribute("data-bar-count"), chart.getAttribute("data-first-bar-t")]);
  return { count: Number(count), first: Number(first) };
}

export async function dragTowardPast(page: Page, chart: Locator, until: () => Promise<void>): Promise<void> {
  await expect(async () => {
    const box = await chart.boundingBox();
    if (!box) throw new Error("차트가 보이지 않습니다");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, y, { steps: 12 });
    await page.mouse.up();
    await until();
  }).toPass({ timeout: 30_000, intervals: [0] });
}
