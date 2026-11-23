import { create } from "zustand";
import type { ServerMode } from "../api/generated/ServerMode";
import type { ServerModeKind } from "../api/generated/ServerModeKind";

export const SERVER_MODE_PATH = "/api/server-mode";

interface ServerModeStore {
  kind: ServerModeKind;
}

export const useServerModeStore = create<ServerModeStore>()(() => ({ kind: "local" }));

export const isPublicMode = (): boolean => useServerModeStore.getState().kind === "public";

export const usePublicMode = (): boolean => useServerModeStore((s) => s.kind === "public");

export function parseServerMode(body: unknown): ServerModeKind {
  const mode = typeof body === "object" && body !== null ? (body as Partial<ServerMode>).mode : undefined;
  return mode === "public" ? "public" : "local";
}
