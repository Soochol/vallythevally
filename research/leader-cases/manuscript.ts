import { array, choice, code, date, finite, link, literal, object, string, union, type Parsed } from "./input-schema.ts";

export const SECTION_TITLES = ["요약", "시대 서사", "실적·재무", "실적을 미리 아는 법", "섹터", "시장환경", "기술적 현상·상대강도", "수급", "밸류에이션", "자본·지분 사건", "소멸", "교훈", "자료 한계와 출처"] as const;
const citation = object({ publishedOn: date, url: link, quote: string });
const sentence = union(
  object({ kind: literal("then-visible"), text: string, asOf: date, citations: array(citation) }),
  object({ kind: literal("retrospective"), text: string, citations: array(citation) }),
);
const milestone = object({ day: date, evidence: array(sentence) });
const schema = object({
  schemaVersion: literal(1), code, title: string,
  milestones: object({ birth: milestone, peak: milestone, extinction: milestone }),
  sections: array(object({ number: finite, sentences: array(sentence) })),
  events: array(object({ publishedOn: date, title: string, url: link, kind: choice(["industry", "policy", "technology", "capital", "index"]), sentences: array(sentence) })),
});
export type Manuscript = Parsed<typeof schema>;
export type Sentence = Parsed<typeof sentence>;
export function parseManuscript(input: unknown): Manuscript {
  const manuscript = schema(input);
  const { birth, peak, extinction } = manuscript.milestones;
  if (!(birth.day <= peak.day && peak.day < extinction.day)) throw new Error("invalid_milestone_order");
  if (manuscript.sections.length !== SECTION_TITLES.length || manuscript.sections.some((s, i) => s.number !== i)) throw new Error("sections_must_be_0_through_12");
  for (const mark of [birth, peak, extinction]) if (!mark.evidence.length) throw new Error("milestone_evidence_required");
  const sentences = [...manuscript.sections.flatMap((s) => s.sentences), ...Object.values(manuscript.milestones).flatMap((m) => m.evidence), ...manuscript.events.flatMap((e) => e.sentences)];
  for (const s of sentences) {
    if (!s.text.trim()) throw new Error("empty_sentence");
    if (s.kind === "then-visible" && (!s.citations.length || s.citations.some((c) => c.publishedOn > s.asOf))) throw new Error("then_visible_requires_already_published_evidence");
  }
  return manuscript;
}
