import type { WorkboardHealthResult } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginService } from "../api.js";
import {
  createWorkboardHealthService,
  projectWorkboardHealth,
  workboardHealthScope,
} from "./health.js";
import { NODE_TARGET } from "./node-ticket.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const NOW = Date.UTC(2026, 10, 7, 9);
const HOUR = 3_600_000;
const UNKNOWN = { status: "unknown", reason: "unreadable" } as const;

function target(nodeId: string) {
  return { ...NODE_TARGET, nodeId };
}

const BOARDS = [
  {
    id: "planning",
    automationJobId: "job-planning",
    orchestration: { defaultAssignee: "dev", defaultTarget: target("mac-1") },
  },
  {
    id: "ios",
    automationJobId: "job-ios",
    orchestration: {
      defaultAssignee: "dev",
      targetRoutes: [
        { labels: ["class:ios"], target: target("linux-1"), alternateTargets: [target("mac-1")] },
      ],
    },
  },
  {
    id: "old",
    automationJobId: "job-old",
    archivedAt: NOW - HOUR,
    orchestration: { defaultAssignee: "ghost", defaultTarget: target("gone-1") },
  },
];

const JOBS = [
  {
    id: "job-planning",
    name: "Planning",
    agentId: "dev",
    enabled: true,
    state: {
      lastRunStatus: "error" as const,
      lastRunAtMs: NOW - 2 * HOUR,
      lastError: "usage limit reached",
      nextRunAtMs: NOW + HOUR,
    },
  },
  {
    id: "job-brief",
    name: "Morning brief",
    agentId: "andri",
    enabled: false,
    state: {
      lastRunStatus: "ok" as const,
      lastRunAtMs: NOW - HOUR,
      lastDeliveryError: "no channel",
    },
  },
  { id: "job-other", agentId: "other", enabled: true },
  { id: "job-old", agentId: "ghost", enabled: true },
];

const NODES = [
  { nodeId: "mac-1", displayName: "Mac mini", connected: true, lastSeenAtMs: NOW - 1000 },
  { nodeId: "gone-1", connected: false },
];

describe("workboard health projection", () => {
  it("reports the live boards' jobs, nodes, and profile windows for their agents and the caller", () => {
    const scope = workboardHealthScope(BOARDS, "andri");
    expect(scope.agentIds).toEqual(["andri", "dev"]);

    const health = projectWorkboardHealth(
      scope,
      {
        jobs: JOBS,
        nodes: NODES,
        accounts: [
          {
            agentId: "dev",
            provider: "anthropic",
            model: "claude-sonnet-5-5",
            profiles: [
              { profileId: "anthropic:spare", usage: { cooldownUntil: NOW - HOUR } },
              {
                profileId: "anthropic:default",
                usage: { disabledUntil: NOW + 2 * HOUR, disabledReason: "billing" },
              },
              {
                profileId: "anthropic:blocked",
                usage: { blockedUntil: NOW + HOUR, blockedReason: "manual" },
              },
            ],
          },
          {
            agentId: "andri",
            provider: "openai",
            model: "gpt-5.5",
            profiles: [
              {
                profileId: "openai:default",
                usage: {
                  cooldownUntil: NOW + 3 * HOUR,
                  cooldownReason: "rate_limit",
                  cooldownClassification: "wham_account_dead",
                },
              },
              { profileId: "openai:env" },
            ],
          },
        ],
      },
      NOW,
    );

    expect(health).toEqual({
      generatedAt: NOW,
      automations: [
        {
          id: "job-brief",
          boardIds: [],
          exists: true,
          name: "Morning brief",
          agentId: "andri",
          enabled: false,
          lastRunStatus: "ok",
          lastRunAt: NOW - HOUR,
          lastError: "no channel",
        },
        { id: "job-ios", boardIds: ["ios"], exists: false },
        {
          id: "job-planning",
          boardIds: ["planning"],
          exists: true,
          name: "Planning",
          agentId: "dev",
          enabled: true,
          lastRunStatus: "error",
          lastRunAt: NOW - 2 * HOUR,
          lastError: "usage limit reached",
          nextRunAt: NOW + HOUR,
        },
      ],
      nodes: [
        { nodeId: "linux-1", boardIds: ["ios"], paired: false },
        {
          nodeId: "mac-1",
          boardIds: ["planning", "ios"],
          paired: true,
          displayName: "Mac mini",
          connected: true,
          lastSeenAt: NOW - 1000,
        },
      ],
      accounts: [
        {
          agentId: "andri",
          provider: "openai",
          model: "gpt-5.5",
          profiles: [
            {
              profileId: "openai:default",
              status: "cooldown",
              until: NOW + 3 * HOUR,
              reason: "wham_account_dead",
            },
            { profileId: "openai:env", status: "ok" },
          ],
        },
        {
          agentId: "dev",
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          profiles: [
            { profileId: "anthropic:spare", status: "ok" },
            {
              profileId: "anthropic:default",
              status: "disabled",
              until: NOW + 2 * HOUR,
              reason: "billing",
            },
            {
              profileId: "anthropic:blocked",
              status: "blocked",
              until: NOW + HOUR,
              reason: "manual",
            },
          ],
        },
      ],
    } satisfies WorkboardHealthResult);
  });

  it("passes an unreadable fact through with its reason", () => {
    const scope = workboardHealthScope(BOARDS, undefined);
    expect(scope.agentIds).toEqual(["dev"]);
    expect(
      projectWorkboardHealth(
        scope,
        {
          jobs: UNKNOWN,
          nodes: UNKNOWN,
          accounts: [{ agentId: "dev", provider: "openai", model: "gpt-5.5", profiles: UNKNOWN }],
        },
        NOW,
      ),
    ).toEqual({
      generatedAt: NOW,
      automations: UNKNOWN,
      nodes: UNKNOWN,
      accounts: [{ agentId: "dev", provider: "openai", model: "gpt-5.5", profiles: UNKNOWN }],
    });
  });
});

describe("workboard health service", () => {
  it("reads the scheduler only while started and the other facts through the runtime", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({
      id: "planning",
      automationJobId: "job-planning",
      orchestration: { defaultAssignee: "dev", defaultTarget: NODE_TARGET },
    });
    const list = vi.fn().mockResolvedValue(JOBS);
    const runtime = {
      config: { current: () => ({}) },
      nodes: {
        list: vi.fn().mockResolvedValue({
          nodes: [{ nodeId: NODE_TARGET.nodeId, connected: false, lastSeenAtMs: NOW - HOUR }],
        }),
      },
      modelConfig: {
        resolveDefaultModelForAgent: ({ agentId }: { agentId?: string }) =>
          agentId === "dev"
            ? { provider: "anthropic", model: "claude-sonnet-5-5" }
            : { provider: "openai", model: "gpt-5.5" },
      },
      modelAuth: {
        ensureAuthProfileStoreAsync: vi.fn().mockResolvedValue({
          version: 1,
          profiles: {
            "anthropic:default": { type: "api_key", provider: "anthropic", key: "k" },
            "openai:default": { type: "api_key", provider: "openai", key: "k" },
          },
          usageStats: {
            "anthropic:default": { cooldownUntil: Date.now() + HOUR, cooldownReason: "rate_limit" },
          },
        }),
        listProfilesForProvider: (
          authStore: { profiles: Record<string, { provider: string }> },
          provider: string,
        ) =>
          Object.entries(authStore.profiles)
            .filter(([, profile]) => profile.provider === provider)
            .map(([profileId]) => profileId),
      },
    };
    const service = createWorkboardHealthService({ store, runtime: runtime as never });
    const context = {
      config: {},
      stateDir: "unused",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getCron: () => ({ list }),
    };

    const stopped = await service.read({ agentId: "andri" });
    expect(stopped.automations).toEqual({
      status: "unknown",
      reason: "The Workboard health service is not running, so no scheduler is readable.",
    });
    expect(stopped.nodes).toEqual([
      {
        nodeId: NODE_TARGET.nodeId,
        boardIds: ["planning"],
        paired: true,
        connected: false,
        lastSeenAt: NOW - HOUR,
      },
    ]);
    expect(stopped.accounts).toMatchObject([
      {
        agentId: "andri",
        provider: "openai",
        profiles: [{ profileId: "openai:default", status: "ok" }],
      },
      {
        agentId: "dev",
        provider: "anthropic",
        profiles: [{ profileId: "anthropic:default", status: "cooldown", reason: "rate_limit" }],
      },
    ]);
    expect(
      runtime.modelAuth.ensureAuthProfileStoreAsync.mock.calls.map(([, options]) => options),
    ).toEqual([
      { readOnly: true, allowKeychainPrompt: false, config: {}, externalCli: { mode: "none" } },
      { readOnly: true, allowKeychainPrompt: false, config: {}, externalCli: { mode: "none" } },
    ]);

    await service.start(context as never);
    const started = await service.read();
    expect(list).toHaveBeenCalledWith({ includeDisabled: true });
    expect(started.automations).toMatchObject([
      { id: "job-planning", exists: true, lastError: "usage limit reached" },
    ]);
    expect(started.accounts).toMatchObject([{ agentId: "dev" }]);

    await (service as OpenClawPluginService).stop?.(context as never);
    expect((await service.read()).automations).toMatchObject({ status: "unknown" });
  });
});
