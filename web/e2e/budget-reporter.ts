import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

const DEFAULT_BUDGET_MS = 30_000;

type OverBudget = { title: string; durationMs: number };

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

  onBegin(config: FullConfig): void {
    this.rootDir = config.rootDir;
    this.outputDir = config.projects[0]?.outputDir ?? "";
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.duration <= this.budget) return;
    const file = relative(join(this.rootDir, ".."), test.location.file);
    this.over.push({ title: `${file}:${test.location.line} › ${test.titlePath().slice(3).join(" › ")}`, durationMs: result.duration });
  }

  onEnd(): void {
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
}

export default BudgetReporter;
