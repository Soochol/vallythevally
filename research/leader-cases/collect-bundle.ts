#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildBundle, type BundleOptions } from "./build-bundle.ts";
import { DART_BASE, readDartKey } from "./dart-source.ts";
import { day, kstDay, publicBase } from "./source-utils.ts";
import { documentChunks, encodeBundle, writeAtomic } from "./bundle-storage.ts";

const USAGE = `node collect-bundle.ts --server <http(s)://host:port> --code <6자리 종목코드> --corp-code <DART 8자리 고유번호> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--sector-map path]
OpenDART 키는 VALLY_ENV_FILE 파일의 OPENDART_API_KEY만 읽습니다. 키가 없으면 자료 한계를 기록합니다.
출력은 이 worktree의 data/leader-cases/<code>/bundle.json입니다.
--dart-base, --fred-base는 로컬 fixture 서버 시험에만 씁니다.
`;
function sourceBase(value: string | undefined, official: string): URL {
  const url = publicBase(value ?? official);
  if (url.origin !== official && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) throw new Error("source_override_must_be_loopback");
  return url;
}
export async function main(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let options: BundleOptions;
  try {
    const { values } = parseArgs({ args, options: { server: { type: "string" }, code: { type: "string" }, "corp-code": { type: "string" }, from: { type: "string" }, to: { type: "string" }, "sector-map": { type: "string" }, "dart-base": { type: "string" }, "fred-base": { type: "string" }, help: { type: "boolean" } }, strict: true });
    if (values.help) { process.stdout.write(USAGE); return 0; }
    if (!values.server || !values.code || !/^[0-9A-Z]{6}$/.test(values.code) || !values["corp-code"] || !/^\d{8}$/.test(values["corp-code"])) throw new Error("invalid_arguments");
    const from = day(values.from ?? "2015-01-01");
    const to = day(values.to ?? kstDay(Date.now() / 1000 - 86400));
    if (from > to || to > kstDay(Date.now() / 1000)) throw new Error("invalid_range");
    options = { server: publicBase(values.server), code: values.code, corp: values["corp-code"], from, to, mapPath: values["sector-map"] ?? path.join(import.meta.dirname, "sectors.json"), dartBase: sourceBase(values["dart-base"], DART_BASE), fredBase: sourceBase(values["fred-base"], "https://fred.stlouisfed.org"), dartKey: await readDartKey(env.VALLY_ENV_FILE) };
  } catch {
    process.stderr.write(`설정이 올바르지 않거나 키 파일을 읽지 못했습니다.\n${USAGE}`);
    return 2;
  }
  let stage = "collection";
  try {
    const bundle = await buildBundle(options);
    const directory = path.resolve(import.meta.dirname, "../../data/leader-cases", options.code);
    const output = path.join(directory, "bundle.json");
    stage = "bundle_serialization";
    const document = await encodeBundle(bundle);
    stage = "bundle_output";
    await writeAtomic(output, documentChunks(document));
    const targetOk = bundle.prices.some((p) => p.kind === "ok" && p.data.symbol === options.code);
    process.stdout.write(JSON.stringify({ output, missingSources: bundle.missing.length, targetPricesAvailable: targetOk }) + "\n");
    return targetOk ? 0 : 1;
  } catch {
    process.stderr.write(`자료 묶음을 만들지 못했습니다: ${stage}\n`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
