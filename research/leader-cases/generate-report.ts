#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "../../web/node_modules/vite/dist/node/index.js";
import { documentBundle, readBundleDocument, writeAtomic } from "./bundle-storage.ts";
import { parseManuscript } from "./manuscript.ts";
import { reportPage } from "./report-page.ts";

export async function browserBundle(): Promise<string> {
  const result = await build({ configFile: false, root: import.meta.dirname, logLevel: "silent", resolve: { alias: { "lightweight-charts": path.resolve(import.meta.dirname, "../../web/node_modules/lightweight-charts/dist/lightweight-charts.production.mjs") } }, build: { write: false, minify: true, target: "es2022", lib: { entry: path.join(import.meta.dirname, "report-browser.ts"), name: "LeaderReport", formats: ["iife"] } } });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap((r) => "output" in r ? r.output : []).filter((o) => o.type === "chunk");
  if (chunks.length !== 1) throw new Error("expected_single_browser_bundle");
  return chunks[0]!.code;
}
const USAGE = "node research/leader-cases/generate-report.ts --manuscript <원고.json> --bundle <bundle.json>\n출력: 이 worktree의 data/leader-cases/<code>/report.html (원천 조회 없음)\n";
export async function main(args: string[]): Promise<number> {
  let stage = "arguments";
  try {
    const { values } = parseArgs({ args, options: { manuscript: { type: "string" }, bundle: { type: "string" }, help: { type: "boolean" } }, strict: true });
    if (values.help) { process.stdout.write(USAGE); return 0; }
    if (!values.manuscript || !values.bundle) throw new Error("manuscript_and_bundle_required");
    stage = "manuscript_input";
    const manuscript = parseManuscript(JSON.parse(await readFile(values.manuscript, "utf8")));
    stage = "bundle_input";
    const document = await readBundleDocument(values.bundle);
    const bundle = await documentBundle(document);
    if (manuscript.code !== bundle.code) throw new Error("manuscript_bundle_code_mismatch");
    stage = "html_generation";
    const html = reportPage(bundle, manuscript, await browserBundle(), document);
    const directory = path.resolve(import.meta.dirname, "../../data/leader-cases", bundle.code);
    const output = path.join(directory, "report.html");
    stage = "html_output";
    await writeAtomic(output, html);
    process.stdout.write(JSON.stringify({ output, code: bundle.code }) + "\n");
    return 0;
  } catch {
    process.stderr.write(`HTML을 만들지 못했습니다: ${stage}\n${USAGE}`);
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
