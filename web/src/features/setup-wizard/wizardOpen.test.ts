import { describe, expect, test } from "vitest";
import type { AccountStatus } from "../../api/generated/AccountStatus";
import { loginReturn, needsChoice, wizardVisible } from "./wizardOpen";

const sync = { lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null };
const signedIn = (state: "running" | "needs_choice"): AccountStatus =>
  ({ state: "signed_in", provider: "google", accountId: "0123456789abcdef0123", signedInAt: 1, sync: state === "running" ? { state, ...sync } : { state, localDocuments: 1, accountDocuments: 2, ...sync } }) as AccountStatus;

describe("마법사를 여는 때", () => {
  test("이 탭에서 로그인을 시작해 돌아왔을 때만 연다. 소유가 다른 PC는 바꾼 뒤를 기다린다", () => {
    expect(loginReturn(signedIn("running"), true)).toBe("open");
    expect(loginReturn(signedIn("running"), false)).toBe("none");
    expect(loginReturn({ state: "owner_mismatch" } as AccountStatus, true)).toBe("wait");
    expect(loginReturn({ state: "signed_out" }, true)).toBe("none");
    expect(loginReturn({ state: "local_only" }, true)).toBe("none");
  });

  test("로컬 전용과 로그인 안 함에서는 보이지 않고, 선택을 기다리면 언제나 보인다", () => {
    expect(wizardVisible({ state: "local_only" }, true)).toBe(false);
    expect(wizardVisible({ state: "signed_out" }, true)).toBe(false);
    expect(wizardVisible(signedIn("running"), false)).toBe(false);
    expect(wizardVisible(signedIn("running"), true)).toBe(true);
    expect(wizardVisible(signedIn("needs_choice"), false)).toBe(true);
    expect(needsChoice(signedIn("needs_choice"))).toBe(true);
    expect(needsChoice(null)).toBe(false);
  });
});
