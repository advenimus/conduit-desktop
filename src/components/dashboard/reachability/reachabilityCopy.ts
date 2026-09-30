import type { BadgeTone } from "../../ui";
import { REACHABILITY_TIMEOUT_MS, type ReachabilityResult, type ReachabilityStatus } from "../../../types/dashboard";

export interface ReachabilityText {
  readonly badge: string;
  readonly tone: BadgeTone;
  readonly detail: string;
}

const TIMEOUT_SECONDS = Math.round(REACHABILITY_TIMEOUT_MS / 1000);

/** The badge, its tone and the detail line for a check result (docs/DASHBOARD.md 8.3). */
export function reachabilityText(result: Pick<ReachabilityResult, "status" | "port" | "latencyMs">): ReachabilityText {
  switch (result.status) {
    case "reachable":
      return { badge: "Up", tone: "success", detail: `Answered in ${result.latencyMs ?? 0} ms` };
    case "refused":
      return {
        badge: "Port closed",
        tone: "warning",
        detail: `The host answered, but nothing is listening on port ${result.port ?? "?"}`,
      };
    case "timeout":
      return { badge: "No answer", tone: "warning", detail: `No answer in ${TIMEOUT_SECONDS} seconds` };
    case "unreachable":
      return { badge: "Down", tone: "danger", detail: "No route to this host" };
    case "not_found":
      return { badge: "Unknown host", tone: "danger", detail: "Could not find this host name" };
    case "invalid":
      return { badge: "Cannot check", tone: "neutral", detail: "The host or port of this entry is not valid" };
    case "not_checkable":
      return { badge: "Cannot check", tone: "neutral", detail: "This entry has no host and port to check" };
  }
}

/** Sort rank for the folder view's Status order; unchecked entries come last. */
export const STATUS_RANK: Readonly<Record<ReachabilityStatus, number>> = {
  reachable: 0,
  refused: 1,
  timeout: 2,
  unreachable: 3,
  not_found: 4,
  invalid: 5,
  not_checkable: 6,
};

export const UNCHECKED_RANK = 7;

export const reachabilityHint = (port: number): string =>
  `Direct check from this device to port ${port}. Proxies are not used.`;
