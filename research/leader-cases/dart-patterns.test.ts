import assert from "node:assert/strict";
import { test } from "node:test";
import { valuations } from "./financial-calculations.ts";
import { day } from "./source-utils.ts";
import { dartPatternFixture as fixture, ORIGINAL, CORRECTED, SHARE_RECEIPT, COMMON, type Evidence, type Statement } from "./fixtures/dart-patterns.ts";

test("DART pattern: voting common shares preserve issued, treasury-excluded and raw kind evidence", async () => {
  const { dart } = await fixture();
  const p = dart.financials.annual.find((p) => p.year === 2020)!;
  assert.equal(p.commonShares.value, 120);
  assert.equal(p.outstandingCommonShares.value, 113);
  assert.equal(p.otherShares.value, 0);
  assert.equal(p.commonShares.availableFrom, "2021-03-22");
  assert.equal(p.commonShares.sources[0]?.accountName, `주식의 총수 ${COMMON}`);
});

test("DART pattern: exact original receipt survives attachment correction with its own publication day", async () => {
  const { dart, calls } = await fixture();
  const p = dart.financials.annual.find((p) => p.year === 2021)!;
  assert.equal(p.single.operatingProfit.value, 200);
  assert.equal(p.single.operatingProfit.sources[0]?.receipt, ORIGINAL);
  assert.equal(p.single.operatingProfit.sources[0]?.filedOn, "2022-03-21");
  assert.equal(p.filedOn, "2022-03-21");
  assert.equal(p.availableFrom, "2022-03-22");
  assert.equal(p.filingLagDays, 80);
  assert.equal(p.single.operatingProfit.availableFrom, "2022-03-22");
  assert.ok(calls.some((url) => url.pathname === "/api/list.json" && url.searchParams.get("last_reprt_at") === "N"));
  assert.equal(dart.disclosures.kind, "ok");
  if (dart.disclosures.kind === "ok") assert.deepEqual(dart.disclosures.data.map((d) => d.receipt), [SHARE_RECEIPT, CORRECTED]);
  assert.equal(dart.financials.timeline.findLast((p) => p.day <= "2022-03-21")?.values?.operatingProfitTtm.value ?? null, null);
  assert.equal(dart.financials.timeline.find((p) => p.day === "2022-03-22")?.values?.operatingProfitTtm.value, 200);
});

for (const kinds of [["보통주"], [" 의결권\t있는 주식 \r\n ( 보통주 ) "]]) test(`DART common kind accepts explicit normalized form ${JSON.stringify(kinds)}`, async () => {
  const { dart } = await fixture({ kinds });
  assert.equal(dart.financials.annual[0]!.commonShares.value, 120);
});
for (const kinds of [[], ["우선주"], ["의결권 있는 주식(우선주)"], ["보통주 비고"], [COMMON, "보통주"], [COMMON, COMMON]]) test(`DART ambiguous or non-common kind remains unavailable ${JSON.stringify(kinds)}`, async () => {
  const { dart } = await fixture({ kinds });
  assert.equal(dart.financials.annual[0]!.commonShares.value, null);
  assert.equal(dart.financials.annual[0]!.outstandingCommonShares.value, null);
});
for (const evidence of ["missing", "company", "stock", "no-stock", "period", "report", "unavailable", "middle-unavailable"] satisfies Evidence[]) test(`DART exact receipt rejects ${evidence} evidence without blocking other periods`, async () => {
  const { dart } = await fixture({ evidence });
  assert.equal(dart.financials.annual[1]!.single.operatingProfit.value, null);
  assert.equal(dart.financials.annual[0]!.commonShares.value, 120);
  assert.equal(dart.disclosures.kind, "ok");
});

test("DART latest corrected numbers never become available at the original receipt date", async () => {
  const { dart } = await fixture({ revisedAccounts: true });
  const p = dart.financials.annual[1]!;
  assert.equal(p.single.operatingProfit.sources[0]?.receipt, CORRECTED);
  assert.equal(p.filedOn, "2022-03-23");
  assert.equal(p.single.operatingProfit.availableFrom, "2022-03-24");
  assert.equal(dart.financials.timeline.findLast((p) => p.day <= "2022-03-22")?.values?.operatingProfitTtm.value ?? null, null);
  assert.equal(valuations([{ day: day("2022-03-21"), c: 100 }], dart.financials, 120)[0]!.epsTtm.value, null);
});

for (const statement of ["company", "period", "report", "mixed-receipt"] satisfies Statement[]) test(`DART financial rows reject ${statement} mismatches independently`, async () => {
  const { dart } = await fixture({ statement });
  assert.equal(dart.financials.annual[1]!.single.operatingProfit.value, null);
  assert.equal(dart.financials.annual[0]!.commonShares.value, 120);
});

test("DART share classes cannot subtract total and common snapshots from different receipts", async () => {
  const { dart } = await fixture({ mixedShareReceipts: true });
  assert.equal(dart.financials.annual[0]!.commonShares.value, 120);
  assert.equal(dart.financials.annual[0]!.otherShares.value, null);
});

for (const evidence of ["unavailable", "middle-unavailable"] satisfies Evidence[]) test(`DART ${evidence} full-list failure retains independently verified final receipt values`, async () => {
  const { dart } = await fixture({ evidence, revisedAccounts: true });
  assert.equal(dart.financials.annual[1]!.single.operatingProfit.value, 200);
  assert.equal(dart.financials.annual[1]!.single.operatingProfit.availableFrom, "2022-03-24");
  assert.ok(dart.sourceFailures.some((f) => f.source === "OpenDART/list/receipts" && f.reason === "dart_status_020"));
});
