import { useQuery } from "@tanstack/react-query";
import type { SymbolCode } from "./generated/SymbolCode";
import type { ViDirection } from "./generated/ViDirection";
import type { ViPlaybook } from "./generated/ViPlaybook";
import type { ViPlaybookKind } from "./generated/ViPlaybookKind";
import { getJson } from "./http";

const PLAYBOOK_STALE_MS = 60_000;

export const viPlaybookQueryKey = (code: SymbolCode, direction: ViDirection, kind: ViPlaybookKind) =>
  ["vi-playbook", code, direction, kind] as const;

export const fetchViPlaybook = (
  code: SymbolCode,
  direction: ViDirection,
  kind: ViPlaybookKind,
  signal?: AbortSignal,
): Promise<ViPlaybook> =>
  getJson<ViPlaybook>(
    `/api/symbols/${encodeURIComponent(code)}/vi-playbook?direction=${encodeURIComponent(direction)}&kind=${encodeURIComponent(kind)}`,
    signal,
  );

export const viPlaybookQuery = (code: SymbolCode, direction: ViDirection, kind: ViPlaybookKind) => ({
  queryKey: viPlaybookQueryKey(code, direction, kind),
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchViPlaybook(code, direction, kind, signal),
  staleTime: PLAYBOOK_STALE_MS,
  retry: false,
});

export function useViPlaybook(
  code: SymbolCode,
  direction: ViDirection,
  kind: ViPlaybookKind,
  enabled: boolean,
) {
  return useQuery({
    ...viPlaybookQuery(code, direction, kind),
    enabled,
  });
}
