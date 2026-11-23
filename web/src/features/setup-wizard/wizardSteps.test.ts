import { describe, expect, test } from "vitest";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { advancesOnConnect, canAdvance, firstStep, isSkippable, nextStep, previousStep, skipTarget, stepMark, wizardSteps } from "./wizardSteps";

const link = (patch: Partial<KiwoomLinkStatus>): KiwoomLinkStatus => ({ state: "noKey", keySource: "none", ...patch }) as KiwoomLinkStatus;
const facts = (patch: Partial<KiwoomLinkStatus>, portalIpConfirmed = false) => ({ link: link(patch), portalIpConfirmed });
const ids = (withChoice: boolean) => wizardSteps(withChoice).map((s) => s.id);

describe("마법사 단계 진행 규칙", () => {
  test("단계는 키 준비, 키 붙여넣기, 끝 셋이고 셋업을 고를 것이 있을 때만 끝 앞에 끼운다", () => {
    expect(ids(false)).toEqual(["prepare", "paste", "done"]);
    expect(ids(true)).toEqual(["prepare", "paste", "setup", "done"]);
    expect(wizardSteps(false).map((s) => s.label)).toEqual(["키 준비", "키 붙여넣기", "끝"]);
  });

  test("연결 전에는 키 준비부터, 이미 연결됐으면 끝부터 열고 셋업을 골라야 하면 고르기부터 연다", () => {
    expect(firstStep(link({ state: "noKey", keySource: "none" }), false)).toBe("prepare");
    expect(firstStep(link({ state: "disconnected", keySource: "env" }), false)).toBe("prepare");
    expect(firstStep(link({ state: "failed", keySource: "file" }), true)).toBe("prepare");
    expect(firstStep(link({ state: "connected", keySource: "file" }), false)).toBe("done");
    expect(firstStep(link({ state: "connected", keySource: "file" }), true)).toBe("setup");
  });

  test("키 준비의 다음은 IP 확인을 마쳐야 열리고, 키 붙여넣기의 다음은 연결돼야 열린다", () => {
    expect(canAdvance("prepare", facts({ keySource: "file" }, false))).toBe(false);
    expect(canAdvance("prepare", facts({ keySource: "file" }, true))).toBe(true);
    expect(canAdvance("paste", facts({ state: "disconnected", keySource: "file" }))).toBe(false);
    expect(canAdvance("paste", facts({ state: "connected", keySource: "file" }))).toBe(true);
    expect(canAdvance("setup", facts({ state: "connected" }, true))).toBe(false);
    expect(canAdvance("done", facts({ state: "connected" }, true))).toBe(false);
  });

  test("나중에 하기는 키 준비와 키 붙여넣기에만 있고 셋업을 골라야 하면 고르기로, 아니면 끝으로 간다", () => {
    expect((["prepare", "paste", "setup", "done"] as const).map(isSkippable)).toEqual([true, true, false, false]);
    expect(skipTarget(false)).toBe("done");
    expect(skipTarget(true)).toBe("setup");
  });

  test("이전은 키 준비 앞으로 가지 않고, 다음은 끝을 넘지 않는다", () => {
    expect(previousStep("prepare")).toBe("prepare");
    expect(previousStep("paste")).toBe("prepare");
    expect(previousStep("setup")).toBe("paste");
    expect(previousStep("done")).toBe("paste");
    expect(nextStep("prepare", false)).toBe("paste");
    expect(nextStep("paste", false)).toBe("done");
    expect(nextStep("paste", true)).toBe("setup");
    expect(nextStep("done", true)).toBe("done");
  });

  test("키 붙여넣기 중에 연결로 바뀔 때만 저절로 다음으로 간다", () => {
    expect(advancesOnConnect("paste", false, true)).toBe(true);
    expect(advancesOnConnect("paste", true, true)).toBe(false);
    expect(advancesOnConnect("paste", false, false)).toBe(false);
    expect(advancesOnConnect("prepare", false, true)).toBe(false);
    expect(advancesOnConnect("done", false, true)).toBe(false);
  });

  test("건너뛴 단계는 끝난 것이 아니라 나중에로 보인다", () => {
    const steps = wizardSteps(false);
    const skipped = facts({ state: "noKey", keySource: "none" });
    expect(stepMark(steps, "prepare", "done", skipped)).toBe("later");
    expect(stepMark(steps, "paste", "done", skipped)).toBe("later");
    expect(stepMark(steps, "done", "done", skipped)).toBe("current");
    expect(stepMark(steps, "paste", "prepare", skipped)).toBe("upcoming");
    expect(stepMark(steps, "paste", "done", facts({ keySource: "env", state: "connected" }))).toBe("done");
    expect(stepMark(steps, "prepare", "done", facts({ keySource: "file", state: "connected" }))).toBe("done");
    expect(stepMark(steps, "prepare", "done", facts({ keySource: "file", state: "disconnected" }))).toBe("later");
    expect(stepMark(steps, "prepare", "done", facts({ keySource: "file", state: "disconnected" }, true))).toBe("done");
  });
});
