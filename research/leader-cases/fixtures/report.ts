import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildBundle } from "../build-bundle.ts";
import { parseManuscript, SECTION_TITLES, type Manuscript } from "../manuscript.ts";
import { day } from "../source-utils.ts";
import { CODE, CORP, FAKE_KEY, fixtureServer, MAP } from "./sources.ts";
import { writeBundle } from "../bundle-storage.ts";

export function syntheticManuscript(): Manuscript {
  const evidence = [{ kind: "retrospective", text: "합성 자료의 날짜를 입력한 시험 근거이며 실제 투자 해석이 아니다.", citations: [] }] as const;
  return parseManuscript({
    schemaVersion: 1, code: CODE, title: "합성 시험 전용 · 주도 사례 리포트",
    milestones: {
      birth: { day: "2016-01-04", evidence }, peak: { day: "2016-09-30", evidence }, extinction: { day: "2017-03-31", evidence },
    },
    sections: SECTION_TITLES.map((title, number) => ({ number, sentences: [
      { kind: "then-visible", text: `${title}: 합성 공시의 공개 시점을 확인하는 문장.`, asOf: "2016-10-14", citations: [{ publishedOn: "2016-10-14", url: "https://example.invalid/synthetic?one=1&two=2", quote: "합성 자료 200 · 실제 자료 아님" }] },
      { kind: "retrospective", text: "사후 해석용 합성 문장. 실제 종목·시세·원고를 사용하지 않았다.", citations: [] },
    ] })),
    events: [{ publishedOn: "2016-10-14", title: "합성 정정 공시 사건", url: "https://example.invalid/synthetic", kind: "capital", sentences: [] }],
  });
}
export async function syntheticInputs(directory: string) {
  await mkdir(directory, { recursive: true });
  const mapPath = path.join(directory, "map.json");
  await writeFile(mapPath, JSON.stringify(MAP));
  const server = await fixtureServer({ priorHalfCorrection: "changed" });
  try {
    const bundle = await buildBundle({ server: server.base, code: CODE, corp: CORP, from: day("2016-01-01"), to: day("2017-12-29"), mapPath, dartBase: server.base, fredBase: server.base, dartKey: FAKE_KEY });
    bundle.technical = bundle.technical.map((t, i) => i >= 35 && i <= 37 ? { ...t, stockToSector: null } : t);
    bundle.fred.push({ kind: "missing", source: "FRED/synthetic-unavailable", reason: "synthetic_source_failure" });
    bundle.missing.push({ source: "FRED/synthetic-unavailable", reason: "synthetic_source_failure" });
    bundle.limitations.unshift("SYNTHETIC FIXTURE ONLY: every price, account and narrative is fabricated for testing.");
    const manuscript = syntheticManuscript();
    const bundlePath = path.join(directory, "bundle.json"), manuscriptPath = path.join(directory, "manuscript.json");
    await writeBundle(bundlePath, bundle);
    await writeFile(manuscriptPath, JSON.stringify(manuscript, null, 2));
    return { bundle, manuscript, bundlePath, manuscriptPath };
  } finally { await server.close(); }
}
