import type { FinancialJobTone } from "../../lib/financialJob";

export const DOT_CLASS: Record<FinancialJobTone, string> = { idle: "bg-text-3", active: "bg-accent", paused: "bg-warning", attention: "bg-danger", done: "bg-success" };

export const TEXT_CLASS: Record<FinancialJobTone, string> = { idle: "text-text-2", active: "text-text-2", paused: "text-warning", attention: "text-danger", done: "text-success" };
