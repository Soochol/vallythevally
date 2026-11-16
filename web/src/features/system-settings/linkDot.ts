import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { ConnectionTone } from "../status/connectionView";

export function linkDotTone(status: KiwoomLinkStatus | null): ConnectionTone {
  if (!status) return "gray";
  switch (status.state) {
    case "noKey":
    case "disconnected":
      return "gray";
    case "connecting":
      return "amber";
    case "connected":
      return "mint";
    case "failed":
      return failureTone(status.problem);
    default: {
      const _exhaustive: never = status.state;
      return _exhaustive;
    }
  }
}

function failureTone(problem: KiwoomLinkStatus["problem"]): ConnectionTone {
  switch (problem) {
    case "issueIntervalWait":
    case "authUncertain":
    case "network":
      return "amber";
    case "authBlocked8050":
    case "keyNeedsCheck":
    case "tokenFileUnusable":
    case "keyFileUnusable":
    case "pathStopped":
    case null:
      return "red";
    default: {
      const _exhaustive: never = problem;
      return _exhaustive;
    }
  }
}
