import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("화면과 엔진의 경계", () => {
  const SRC = path.resolve(import.meta.dirname, "../..");
  const VAULT = import.meta.dirname;
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name: string) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  const importsOf = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => path.resolve(path.dirname(file), m[1]!));
  const SECRET_MODULES = [path.join(VAULT, "engine"), path.join(VAULT, "internals")];

  it("엔진용 모듈은 엔진 코드만 가져다 쓴다", () => {
    const allowed = new Set([path.join(VAULT, "engine.ts"), path.join(VAULT, "vault.ts")]);
    const offenders = sources(SRC).filter((file) => !allowed.has(file) && importsOf(file).some((target) => SECRET_MODULES.includes(target)));
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it("보관소의 화면용 출구는 엔진용 모듈을 다시 내보내지 않는다", () => {
    expect(readFileSync(path.join(VAULT, "index.ts"), "utf8")).not.toMatch(/engine|internals/);
  });

  it("보관소는 DOM 전역을 쓰지 않는다", () => {
    for (const file of sources(VAULT)) expect(readFileSync(file, "utf8")).not.toMatch(/\b(window|document|localStorage|sessionStorage)\b|document\.cookie/);
  });
});
