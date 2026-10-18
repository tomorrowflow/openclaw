import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type {
  ControlUiHost,
  ControlUiSessionListResult,
  ControlUiSessionListSubscription,
} from "openclaw/plugin-sdk/control-ui";
import type { GatewaySessionRow } from "../../api/types.ts";
import { workboardHost } from "../../host.ts";
import { formatUiError } from "../format-error.ts";
import { workboardCardSessionKey } from "./card-state.ts";
import { isReservedSessionKey, workboardSessionKeyMatches } from "./session-links.ts";
import type { WorkboardCard } from "./types.ts";

export type WorkboardSessionResolution =
  | { key: string; status: "resolved"; session: GatewaySessionRow }
  | {
      key: string;
      status: "unknown" | "unavailable" | "ambiguous";
      candidates?: readonly GatewaySessionRow[];
      error?: string;
    };

export function workboardCardSessionTarget(
  card: WorkboardCard,
  session?: BoardGetParams,
): BoardGetParams | undefined {
  const key = session?.sessionKey ?? workboardCardSessionKey(card);
  // Provisional links need a resolved key; reserved keys also need an explicit owner.
  // The card's current assignee does not identify the original execution.
  if (
    !key ||
    key.toLowerCase().startsWith("subagent:workboard-") ||
    (isReservedSessionKey(key) && !session?.agentId)
  ) {
    return undefined;
  }
  return session ?? { sessionKey: key };
}

function resolveSession(
  key: string,
  result: ControlUiSessionListResult,
): WorkboardSessionResolution {
  const exact = result.sessions.find(
    (session) => workboardHost().sessions.normalizeKey(session.key) === key,
  );
  if (exact) {
    return { key, status: "resolved", session: exact };
  }
  const candidates = result.sessions.filter((session) =>
    workboardSessionKeyMatches(session.key, key),
  );
  if (candidates.length > 1) {
    return { key, status: "ambiguous", candidates };
  }
  // Pending deletions can hide rows without changing pagination metadata.
  // Neither that gap nor a partial page establishes a provisional link's owner.
  if (result.hasMore !== false || (result.totalCount ?? 0) > result.sessions.length) {
    return { key, status: "unknown", candidates };
  }
  const session = candidates[0];
  return session ? { key, status: "resolved", session } : { key, status: "unavailable" };
}

/** One open card owns one bounded lookup; the sidebar is not a session directory. */
export function createWorkboardSessionResolver(host: ControlUiHost, notify: () => void) {
  let key = "";
  let active = false;
  let disposed = false;
  let subscription: ControlUiSessionListSubscription | undefined;
  let resolution: WorkboardSessionResolution | undefined;

  return {
    get resolution() {
      return resolution;
    },
    sync(sessionKey: string | undefined, enabled: boolean) {
      const nextKey = workboardHost().sessions.normalizeKey(sessionKey ?? "");
      if (disposed || (key === nextKey && active === enabled)) {
        return;
      }
      subscription?.dispose();
      subscription = undefined;
      key = nextKey;
      active = enabled;
      const reserved = isReservedSessionKey(key);
      resolution = key ? { key, status: reserved ? "ambiguous" : "unknown" } : undefined;
      if (!active || !key || reserved) {
        return;
      }
      try {
        subscription = host.sessions.observe(
          {
            search: key,
            archived: "all",
            limit: 2,
            configuredAgentsOnly: false,
            includeGlobal: false,
            includeUnknown: false,
            includeDerivedTitles: false,
            includeLastMessage: false,
          },
          ({ result, error }) => {
            resolution =
              result && !error
                ? resolveSession(key, result)
                : {
                    key,
                    status: "unknown",
                    ...(error ? { error } : {}),
                    candidates: result?.sessions.filter((session) =>
                      workboardSessionKeyMatches(session.key, key),
                    ),
                  };
            notify();
          },
        );
      } catch (error) {
        resolution = { key, status: "unknown", error: formatUiError(error) };
        notify();
      }
    },
    refresh() {
      const current = subscription;
      if (current) {
        void current.refresh().catch((error: unknown) => {
          if (!disposed && subscription === current) {
            resolution = {
              key,
              status: "unknown",
              candidates:
                resolution?.status === "resolved" ? [resolution.session] : resolution?.candidates,
              error: formatUiError(error),
            };
            notify();
          }
        });
      }
    },
    dispose() {
      disposed = true;
      subscription?.dispose();
      subscription = undefined;
    },
  };
}

/**
 * Running cards each own one bounded lookup: the roster omits workboard
 * subagent sessions, so a closed running card would otherwise read as unknown.
 */
export function createWorkboardSessionResolverPool(host: ControlUiHost, notify: () => void) {
  const resolvers = new Map<string, ReturnType<typeof createWorkboardSessionResolver>>();

  return {
    get sessions(): GatewaySessionRow[] {
      return [...resolvers.values()].flatMap(({ resolution }) =>
        resolution?.status === "resolved" ? [resolution.session] : [],
      );
    },
    sync(sessionKeys: readonly string[], enabled: boolean) {
      const keys = new Set(
        sessionKeys
          .map((sessionKey) => workboardHost().sessions.normalizeKey(sessionKey))
          .filter((key) => key && !isReservedSessionKey(key)),
      );
      for (const [key, resolver] of resolvers) {
        if (!keys.has(key)) {
          resolver.dispose();
          resolvers.delete(key);
        }
      }
      for (const key of keys) {
        let resolver = resolvers.get(key);
        if (!resolver) {
          resolver = createWorkboardSessionResolver(host, notify);
          resolvers.set(key, resolver);
        }
        resolver.sync(key, enabled);
      }
    },
    refresh() {
      for (const resolver of resolvers.values()) {
        resolver.refresh();
      }
    },
    dispose() {
      for (const resolver of resolvers.values()) {
        resolver.dispose();
      }
      resolvers.clear();
    },
  };
}
