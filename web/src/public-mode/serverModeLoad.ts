import { getJson } from "../api/http";
import { parseServerMode, SERVER_MODE_PATH, useServerModeStore } from "./serverMode";
import type { ServerModeKind } from "../api/generated/ServerModeKind";

export const SERVER_MODE_TIMEOUT_MS = 5_000;

type ReadMode = (signal: AbortSignal) => Promise<unknown>;

const readFromServer: ReadMode = (signal) => getJson<unknown>(SERVER_MODE_PATH, signal);

export async function loadServerMode(read: ReadMode = readFromServer): Promise<ServerModeKind> {
  let kind: ServerModeKind = "local";
  try {
    kind = parseServerMode(await read(AbortSignal.timeout(SERVER_MODE_TIMEOUT_MS)));
  } catch {
    kind = "local";
  }
  useServerModeStore.setState({ kind });
  return kind;
}
