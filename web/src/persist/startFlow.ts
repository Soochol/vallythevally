import type { AccountStatus } from "../api/generated/AccountStatus";

export type SetupLifecycle = "waiting" | "running" | "suspended";
export type StartStep = "boot" | "suspend" | "reload" | "none";

export const opensSetup = (status: AccountStatus) => status.state === "local_only" || status.state === "signed_in";

export function stepFor(lifecycle: SetupLifecycle, status: AccountStatus): StartStep {
  const open = opensSetup(status);
  if (lifecycle === "waiting") return open ? "boot" : "none";
  if (lifecycle === "running") return open ? "none" : "suspend";
  return open ? "reload" : "none";
}
