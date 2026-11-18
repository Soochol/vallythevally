import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";

const DEFAULT_BUDGET_MS = 30_000;

type OverBudget = { title: string; durationMs: number };

type DurationRecord = {
  file: string;
  line: number;
  title: string;
  status: TestResult["status"];
  durationMs: number;
  workerIndex: number;
  startMs: number;
  retry: number;
};

function budgetMs(): number {
  const raw = process.env.VALLY_E2E_BUDGET_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUDGET_MS;
}

class BudgetReporter implements Reporter {
  private readonly budget = budgetMs();
  private readonly over: OverBudget[] = [];
  private rootDir = process.cwd();
  private outputDir = "";
  private readonly durations: DurationRecord[] = [];
  private runStart = new Date();

  onBegin(config: FullConfig, _suite: Suite): void {
    this.rootDir = config.rootDir;
    this.runStart = new Date();
    this.outputDir = config.projects[0]?.outputDir ?? "";
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const file = relative(join(this.rootDir, ".."), test.location.file);
    this.durations.push({
      file,
      line: test.location.line,
      title: test.titlePath().slice(3).join(" › "),
      status: result.status,
      durationMs: result.duration,
      workerIndex: result.workerIndex,
      startMs: result.startTime.getTime() - this.runStart.getTime(),
      retry: result.retry,
    });
    if (result.duration <= this.budget) return;
    this.over.push({ title: `${file}:${test.location.line} › ${test.titlePath().slice(3).join(" › ")}`, durationMs: result.duration });
  }

  onEnd(_result: FullResult): void {
    this.writeDurations();
    this.over.sort((a, b) => b.durationMs - a.durationMs);
    if (this.outputDir) {
      mkdirSync(this.outputDir, { recursive: true });
      const path = join(this.outputDir, "budget.json");
      writeFileSync(path, JSON.stringify({ budgetMs: this.budget, count: this.over.length, tests: this.over }, null, 2));
      process.stdout.write(`\ne2e 시간 예산 기록: ${path}\n`);
    }
    if (this.over.length === 0) return;
    const lines = this.over.map(item => `  ${item.title} (${(item.durationMs / 1000).toFixed(1)}s)`);
    process.stdout.write(`\ne2e 시간 예산 ${this.budget / 1000}초를 넘은 시험 ${this.over.length}개 (경고만 한다. 부하가 높으면 시간이 3~5배 늘 수 있다):\n${lines.join("\n")}\n`);
  }

  private writeDurations(): void {
    const json = JSON.stringify({ runStart: this.runStart.toISOString(), count: this.durations.length, tests: this.durations });
    if (this.outputDir) {
      mkdirSync(this.outputDir, { recursive: true });
      writeFileSync(join(this.outputDir, "durations.json"), json);
    }
    process.stdout.write(`\ne2e-durations: ${gzipSync(json).toString("base64")}\n`);
  }
}

export default BudgetReporter;
