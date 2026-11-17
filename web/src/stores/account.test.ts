import { beforeEach, describe, expect, test } from "vitest";
import type { AccountStatus } from "../api/generated/AccountStatus";
import { type Connect, MarketSocket } from "../api/socket";
import { receiveAccountPush, useAccountStore } from "./account";

const signedIn: AccountStatus = { state: "signed_in", provider: "google", accountId: "0123456789abcdef", signedInAt: 1_700_000_000, sync: { state: "running", lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null } };

beforeEach(() => useAccountStore.setState({ status: null, pushes: 0, loginFailure: null }));

describe("계정 상태 저장소", () => {
  test("WebSocket의 account 메시지가 상태를 바꾼다", () => {
    let on: Parameters<Connect>[1] | undefined;
    const socket = new MarketSocket({ url: () => "ws://test/api/ws", connect: (_url, events) => ((on = events), { send() {}, close() {} }), onAccount: receiveAccountPush });
    socket.start();
    on!.message(JSON.stringify({ type: "account", status: signedIn }));
    expect(useAccountStore.getState().status).toEqual(signedIn);
    on!.message(JSON.stringify({ type: "account", status: { state: "signed_out" } }));
    expect(useAccountStore.getState().status).toEqual({ state: "signed_out" });
  });

  test("요청하는 사이 메시지가 왔으면 GET 응답은 버린다", () => {
    const { receivePush, receiveSnapshot } = useAccountStore.getState();
    const before = useAccountStore.getState().pushes;
    receivePush({ state: "signed_out" });
    receiveSnapshot(signedIn, before);
    expect(useAccountStore.getState().status).toEqual({ state: "signed_out" });
  });

  test("메시지가 없었으면 GET 응답을 받는다", () => {
    const { receiveSnapshot } = useAccountStore.getState();
    receiveSnapshot(signedIn, useAccountStore.getState().pushes);
    expect(useAccountStore.getState().status).toEqual(signedIn);
  });
});
