import { describe, expect, test, vi } from "vitest";
import type { AccountStatus } from "../api/generated/AccountStatus";
import { start, type StartDeps } from "./start";
import { stepFor } from "./startFlow";

const signedIn: AccountStatus = { state: "signed_in", provider: "naver", accountId: "abcdef0123456789", signedInAt: 1 };
const mismatch: AccountStatus = { state: "owner_mismatch", provider: "naver", accountId: "abcdef0123456789", signedInAt: 1, localOwner: "ffffffff00000000" };

function harness(first: AccountStatus | "unreadable") {
  let listener: (s: AccountStatus) => void = () => {};
  const deps = {
    loadAccount: vi.fn(async () => {
      if (first === "unreadable") throw new Error("offline");
      listener(first);
    }),
    boot: vi.fn(async () => {}),
    suspendSetup: vi.fn(),
    reload: vi.fn(),
    subscribe: (l: (s: AccountStatus) => void) => ((listener = l), () => {}),
  } satisfies StartDeps;
  return { deps, push: (s: AccountStatus) => listener(s) };
}

describe("시작 흐름의 상태별 분기", () => {
  test.each([["local_only", { state: "local_only" } as AccountStatus], ["signed_in", signedIn]])("%s이면 셋업을 되살린다", async (_name, status) => {
    const { deps } = harness(status);
    await start(deps);
    expect(deps.boot).toHaveBeenCalledOnce();
  });

  test.each([["signed_out", { state: "signed_out" } as AccountStatus], ["owner_mismatch", mismatch]])("%s이면 셋업을 되살리지 않는다", async (_name, status) => {
    const { deps } = harness(status);
    await start(deps);
    expect(deps.boot).not.toHaveBeenCalled();
  });

  test("계정 상태를 읽지 못하면 지금의 시작 길로 간다", async () => {
    const { deps } = harness("unreadable");
    await start(deps);
    expect(deps.boot).toHaveBeenCalledOnce();
  });

  test("실행 중에 signed_out이 되면 저장을 멈추고 다시 로그인하면 새로 시작한다", async () => {
    const { deps, push } = harness(signedIn);
    await start(deps);
    push({ state: "signed_out" });
    expect(deps.suspendSetup).toHaveBeenCalledOnce();
    expect(deps.reload).not.toHaveBeenCalled();
    push(signedIn);
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  test("로그인 화면에서 열린 상태가 오면 처음 한 번만 되살린다", async () => {
    const { deps, push } = harness({ state: "signed_out" });
    await start(deps);
    push(signedIn);
    push(signedIn);
    expect(deps.boot).toHaveBeenCalledOnce();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  test("owner_mismatch에서 바꾸기가 끝나면 되살린다", async () => {
    const { deps, push } = harness(mismatch);
    await start(deps);
    push(signedIn);
    expect(deps.boot).toHaveBeenCalledOnce();
  });
});

test("계정이 바뀌어도 실행 중이면 아무것도 하지 않는다", () => {
  expect(stepFor("running", signedIn)).toBe("none");
  expect(stepFor("suspended", { state: "signed_out" })).toBe("none");
});
