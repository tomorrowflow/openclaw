import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { gatewayModelAccounts } from "./node-ticket-accounts.js";

it.each([
  { cooling: ["anthropic:work"], usable: true },
  { cooling: ["anthropic:work", "anthropic:home"], usable: false },
])("reads the agent's Claude accounts from its auth store (cooling: $cooling)", async (row) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const now = Date.parse("2026-11-28T12:00:00Z");
    const agentDir = state.agentDir("dev");
    const config: OpenClawConfig = {
      agents: { entries: { dev: { agentDir } } },
      plugins: { enabled: false },
    };
    await state.writeConfig(config);
    await state.writeAuthProfiles(
      {
        version: 1,
        profiles: {
          "anthropic:work": { type: "token", provider: "anthropic", token: "synthetic-work" },
          "anthropic:home": { type: "token", provider: "anthropic", token: "synthetic-home" },
        },
        order: { anthropic: ["anthropic:work", "anthropic:home"] },
        usageStats: Object.fromEntries(
          row.cooling.map((id) => [
            id,
            { cooldownUntil: now + 60 * 60 * 1000, cooldownReason: "rate_limit" },
          ]),
        ),
      },
      "dev",
    );

    expect(await gatewayModelAccounts.hasUsableAccount(config, "dev", now)).toBe(row.usable);
  });
});
