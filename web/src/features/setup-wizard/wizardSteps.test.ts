import { describe, expect, test } from "vitest";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { canAdvance, firstStep, isSkippable, nextStep, previousStep, stepMark, WIZARD_STEPS } from "./wizardSteps";

const link = (patch: Partial<KiwoomLinkStatus>): KiwoomLinkStatus => ({ state: "noKey", keySource: "none", ...patch }) as KiwoomLinkStatus;
const facts = (patch: Partial<KiwoomLinkStatus>, portalIpConfirmed = false) => ({ link: link(patch), portalIpConfirmed });

describe("마법사 단계 진행 규칙", () => {
  test("단계 순서는 로그인, IP 확인, 키움 키, 연결, 기본 셋업이다", () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(["login", "ip", "key", "connect", "setup"]);
  });

  test("키가 없거나 연결 안 됨이면 IP 확인부터, 이미 연결됐으면 기본 셋업부터 연다", () => {
    expect(firstStep(link({ state: "noKey", keySource: "none" }))).toBe("ip");
    expect(firstStep(link({ state: "disconnected", keySource: "env" }))).toBe("ip");
    expect(firstStep(link({ state: "disconnected", keySource: "file" }))).toBe("ip");
    expect(firstStep(link({ state: "failed", keySource: "file" }))).toBe("ip");
    expect(firstStep(link({ state: "connected", keySource: "file" }))).toBe("setup");
  });

  test("다음 단계는 그 단계가 끝나야 열리고, 기본 셋업 단계에는 다음이 없다", () => {
    expect(canAdvance("key", facts({ keySource: "none" }))).toBe(false);
    expect(canAdvance("key", facts({ keySource: "file" }))).toBe(true);
    expect(canAdvance("ip", facts({ keySource: "file" }, false))).toBe(false);
    expect(canAdvance("ip", facts({ keySource: "file" }, true))).toBe(true);
    expect(canAdvance("connect", facts({ state: "disconnected", keySource: "file" }))).toBe(false);
    expect(canAdvance("connect", facts({ state: "connected", keySource: "file" }))).toBe(true);
    expect(canAdvance("setup", facts({ state: "connected" }, true))).toBe(false);
  });

  test("나중에 하기는 키·IP·연결에만 있다", () => {
    expect(["login", "ip", "key", "connect", "setup"].map((id) => isSkippable(id as never))).toEqual([false, true, true, true, false]);
  });

  test("이전은 로그인 단계로 돌아가지 않고, 다음은 마지막을 넘지 않는다", () => {
    expect(previousStep("ip")).toBe("ip");
    expect(previousStep("key")).toBe("ip");
    expect(previousStep("setup")).toBe("connect");
    expect(nextStep("ip")).toBe("key");
    expect(nextStep("key")).toBe("connect");
    expect(nextStep("setup")).toBe("setup");
  });

  test("건너뛴 단계는 끝난 것이 아니라 나중에로 보인다", () => {
    const skipped = facts({ state: "noKey", keySource: "none" });
    expect(stepMark("login", "setup", skipped)).toBe("done");
    expect(stepMark("key", "setup", skipped)).toBe("later");
    expect(stepMark("connect", "setup", skipped)).toBe("later");
    expect(stepMark("setup", "setup", skipped)).toBe("current");
    expect(stepMark("connect", "key", skipped)).toBe("upcoming");
    expect(stepMark("key", "setup", facts({ keySource: "env", state: "connected" }))).toBe("done");
    expect(stepMark("ip", "setup", facts({ keySource: "file", state: "connected" }))).toBe("done");
    expect(stepMark("ip", "setup", facts({ keySource: "file", state: "disconnected" }))).toBe("later");
  });
});
