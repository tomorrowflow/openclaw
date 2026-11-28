import type { WorkboardCard } from "@openclaw/workboard-contract";
import { resolveSessionAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { parseProviderUsageLimit } from "openclaw/plugin-sdk/provider-usage-limit";
import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { nodeTicketUsageLimits } from "./node-ticket-start-queue.js";
import { workboardSessionKeyForCard } from "./session-link.js";

// Node tickets run Claude CLI, whose subscription logins are Anthropic auth profiles.
const NODE_TICKET_AUTH_PROVIDER = "anthropic";

/** Whether the Gateway still has a model account to run an agent's next turn on. */
export type WorkboardModelAccounts = {
  hasUsableAccount(config: OpenClawConfig, agentId: string, now: number): Promise<boolean>;
};

const loadAuthRuntime = createLazyRuntimeModule(async () => {
  const [agentRuntime, agentScope] = await Promise.all([
    import("openclaw/plugin-sdk/agent-runtime"),
    import("openclaw/plugin-sdk/agent-scope-runtime"),
  ]);
  return { ...agentRuntime, resolveAgentDir: agentScope.resolveAgentDir };
});

/**
 * Reads the agent's Anthropic accounts in the Gateway's own order. A usage
 * limit puts the account that hit it in cooldown, so another account outside
 * cooldown is the one the next turn runs on.
 */
export const gatewayModelAccounts: WorkboardModelAccounts = {
  async hasUsableAccount(config, agentId, now) {
    const {
      isProfileInCooldown,
      loadAuthProfileStoreForRuntimeAsync,
      resolveAgentDir,
      resolveAuthProfileOrder,
    } = await loadAuthRuntime();
    const store = await loadAuthProfileStoreForRuntimeAsync(resolveAgentDir(config, agentId), {
      readOnly: true,
      config,
      externalCli: { mode: "none" },
    });
    return resolveAuthProfileOrder({
      cfg: config,
      store,
      provider: NODE_TICKET_AUTH_PROVIDER,
      readinessMode: "read-only",
    }).some((profileId) => !isProfileInCooldown(store, profileId, now));
  },
};

/**
 * Whether the run before the card's last one also hit a usage limit that has
 * not reset. Its retry already went to whatever account the Gateway picked
 * and failed again, so another start would only repeat that failure.
 */
function limitedTwice(card: WorkboardCard, now: number): boolean {
  const previous = card.metadata?.attempts?.at(-2);
  const resetsAt =
    previous?.error && previous.endedAt !== undefined
      ? parseProviderUsageLimit(previous.error, previous.endedAt)?.resetsAt
      : undefined;
  return resetsAt !== undefined && resetsAt > now;
}

/**
 * Nodes held for a usage limit. A usage limit cools down the Gateway account
 * that hit it, so a ticket whose agent still has another account outside
 * cooldown starts there instead of waiting out the reset.
 */
export async function nodeUsageLimitHolds(
  cards: readonly WorkboardCard[],
  now: number,
  accounts: WorkboardModelAccounts,
  assertOwnerCurrent: (() => void) | undefined,
): Promise<Map<string, number>> {
  const limited = cards.filter((card) => (card.startRequest?.usageLimitResetsAt ?? 0) > now);
  if (limited.length === 0) {
    return new Map();
  }
  const config = await captureRuntimeConfigAsyncReader({ assertCurrent: assertOwnerCurrent })();
  const byAgent = new Map<string, Promise<boolean>>();
  const released = new Set<string>();
  for (const card of limited) {
    if (limitedTwice(card, now)) {
      continue;
    }
    const agentId = resolveSessionAgentId({ config, sessionKey: workboardSessionKeyForCard(card) });
    if (!byAgent.has(agentId)) {
      // An unreadable account store keeps the hold, as before accounts were consulted.
      byAgent.set(
        agentId,
        accounts.hasUsableAccount(config, agentId, now).catch(() => false),
      );
    }
    if (await byAgent.get(agentId)) {
      released.add(card.id);
    }
  }
  return nodeTicketUsageLimits(cards, now, released);
}
