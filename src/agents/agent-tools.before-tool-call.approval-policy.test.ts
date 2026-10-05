import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_RESTART_UNAVAILABLE_REASON } from "../../packages/gateway-protocol/src/restart-unavailable.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  isGatewayRestartBlockedSession,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import {
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import type { ExtensionContext } from "./sessions/index.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(),
  runBeforeToolCall: vi.fn(),
}));
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => hookRunner }));
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
const mockCallGateway = vi.mocked(callGatewayTool);

beforeEach(() => {
  resetDiagnosticSessionStateForTest();
  resetDiagnosticEventsForTest();
  hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
  hookRunner.runBeforeToolCall.mockReset();
  mockCallGateway.mockReset();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  resetDiagnosticRunActivityForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("plugin approval policy subject and setup guidance", () => {
  it.each(["wrapped", "adapted"] as const)(
    "binds a %s tool approval to its registered owner rather than the approval hook owner",
    async (path) => {
      hookRunner.runBeforeToolCall.mockResolvedValue({
        requireApproval: {
          title: "Review diff",
          description: "Review selected tool call",
          pluginId: "review-hook",
        },
      });
      mockCallGateway.mockResolvedValueOnce({ id: "server-id-diffs", status: "accepted" });
      mockCallGateway.mockResolvedValueOnce({ id: "server-id-diffs", decision: "allow-once" });
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      const selectedTool = { name: "diffs", execute } as unknown as AnyAgentTool;
      setPluginToolMeta(selectedTool, { pluginId: "diffs", optional: false });
      const context = { agentId: "main", sessionKey: "main", loopDetection: { enabled: false } };
      if (path === "wrapped") {
        await wrapToolWithBeforeToolCallHook(selectedTool, context).execute(
          "call-diffs",
          {},
          undefined,
          undefined,
        );
      } else {
        const [definition] = toToolDefinitions([selectedTool], context);
        await definition?.execute("call-diffs", {}, undefined, undefined, {} as ExtensionContext);
      }
      expect(mockCallGateway.mock.calls[0]?.[2]).toMatchObject({
        policySubject: { pluginKey: "diffs", tool: "diffs" },
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("includes channel plugin setup guidance when a Slack request has no approval route", async () => {
    const describePluginApprovalSetup = vi.fn(
      () => "Check `approvals.plugin.slack` and the connected bot workspace.",
    );
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
            approvalCapability: {
              getActionAvailabilityState: () => ({ kind: "enabled" as const }),
              getExecInitiatingSurfaceState: () => ({ kind: "enabled" as const }),
              describePluginApprovalSetup,
            },
          },
        },
      ]),
    );
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: { title: "Review diff", description: "Render diff" },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "plugin:no-route", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "diffs",
      params: {},
      ctx: {
        agentId: "main",
        sessionKey: "main",
        turnSourceChannel: "slack",
        turnSourceAccountId: "default",
      },
    });

    expect(result).toHaveProperty(
      "reason",
      "Plugin approval unavailable (no approval route)\n\nCheck `approvals.plugin.slack` and the connected bot workspace.",
    );
    expect(describePluginApprovalSetup).toHaveBeenCalledWith({
      channel: "slack",
      channelLabel: "Slack",
      accountId: "default",
    });
    expect(mockCallGateway).toHaveBeenCalledTimes(1);
  });

  it("parks a call the restart drain refuses until its run aborts", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: { title: "Approval", description: "Restart drain refusal" },
    });
    markGatewayRestartDraining();
    try {
      const run = new AbortController();
      mockCallGateway.mockRejectedValueOnce(
        new GatewayClientRequestError({ code: "UNAVAILABLE", message: "approval service down" }),
      );
      const unrelated = await runBeforeToolCallHook({
        toolName: "diffs",
        params: {},
        ctx: { agentId: "main", sessionKey: "main", sessionId: "unrelated-session" },
        signal: run.signal,
      });
      expect(unrelated).toHaveProperty("reason", "Plugin approval required (gateway unavailable)");
      expect(isGatewayRestartBlockedSession("unrelated-session")).toBe(false);

      mockCallGateway.mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message: "plugin.approval.request unavailable during gateway restart",
          details: {
            method: "plugin.approval.request",
            reason: GATEWAY_RESTART_UNAVAILABLE_REASON,
          },
        }),
      );
      const parked = runBeforeToolCallHook({
        toolName: "diffs",
        params: {},
        ctx: { agentId: "main", sessionKey: "main", sessionId: "restart-session" },
        signal: run.signal,
      });
      await vi.waitFor(() => expect(isGatewayRestartBlockedSession("restart-session")).toBe(true));

      run.abort();
      await expect(parked).resolves.toHaveProperty("reason", "Approval cancelled (run aborted)");
      expect(isGatewayRestartBlockedSession("restart-session")).toBe(false);
    } finally {
      resetGatewayWorkAdmission();
    }
  });
});
