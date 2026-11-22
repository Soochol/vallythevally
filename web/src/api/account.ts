import { readSession } from "../public-mode/session";
import { isPublicMode } from "../public-mode/serverMode";
import { useAccountStore } from "../stores/account";
import type { AccountConfirm } from "./generated/AccountConfirm";
import type { AccountLoginRequest } from "./generated/AccountLoginRequest";
import type { AccountLoginStart } from "./generated/AccountLoginStart";
import type { AccountProvider } from "./generated/AccountProvider";
import type { AccountStatus } from "./generated/AccountStatus";
import type { InitialSyncChoice } from "./generated/InitialSyncChoice";
import type { InitialSyncRequest } from "./generated/InitialSyncRequest";
import { getJson, sendJson } from "./http";

const ACCOUNT = "/api/account";

export async function loadAccount(signal?: AbortSignal): Promise<void> {
  const pushesAtRequest = useAccountStore.getState().pushes;
  const status = isPublicMode() ? await readSession() : await getJson<AccountStatus>(ACCOUNT, signal);
  useAccountStore.getState().receiveSnapshot(status, pushesAtRequest);
}

async function applyStatus(run: () => Promise<AccountStatus>): Promise<void> {
  const pushesAtRequest = useAccountStore.getState().pushes;
  useAccountStore.getState().receiveSnapshot(await run(), pushesAtRequest);
}

const confirmed = (path: string) => applyStatus(() => sendJson<AccountStatus>("POST", path, JSON.stringify({ confirm: true } satisfies AccountConfirm)));

export const startLogin = (provider: AccountProvider) =>
  sendJson<AccountLoginStart>("POST", `${ACCOUNT}/login`, JSON.stringify({ provider } satisfies AccountLoginRequest));
export const logout = () => applyStatus(() => sendJson<AccountStatus>("POST", `${ACCOUNT}/logout`, "{}"));
export const deleteAccount = () => confirmed(`${ACCOUNT}/delete`);
export const replaceLocalSetup = () => confirmed(`${ACCOUNT}/replace-local`);
export const syncNow = () => applyStatus(() => sendJson<AccountStatus>("POST", `${ACCOUNT}/sync`, "{}"));
export const initialSync = (choice: InitialSyncChoice) =>
  applyStatus(() => sendJson<AccountStatus>("POST", `${ACCOUNT}/initial-sync`, JSON.stringify({ choice } satisfies InitialSyncRequest)));
