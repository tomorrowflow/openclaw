/** The clearEnv a paired node receives must pass that node's own request decoder. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import {
  decodeClaudeCliNodeRunParams,
  NODE_CLAUDE_CLEAR_ENV_KEYS,
} from "../../node-host/invoke-agent-cli-claude-params.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  setCliRunnerExecuteTestDeps,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("paired-node Claude clearEnv", () => {
  it("bounds selected-auth clearEnv to what the node accepts", async () => {
    const invokeNode = vi.fn(async (params: Parameters<typeof invokeNodeClaudeCliRun>[0]) => {
      params.onProgress(`${JSON.stringify({ type: "result", result: "ok" })}\n`);
      return {
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: false }),
      };
    });
    setCliRunnerExecuteTestDeps({ invokeNodeClaudeCliRun: invokeNode });
    // The Claude backend also clears thinking keys the node protocol does not list.
    const context = buildPreparedCliRunContext({
      backend: { clearEnv: [...NODE_CLAUDE_CLEAR_ENV_KEYS, "MAX_THINKING_TOKENS"] },
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
    });
    context.preparedBackend.secretInput = {
      fd: 3,
      fingerprint: "selected-node-token-fingerprint",
      createData: () => Buffer.from("selected-node-token"),
    };

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });

    const sent = invokeNode.mock.calls[0]?.[0];
    expect(sent?.clearEnv).toEqual([...NODE_CLAUDE_CLEAR_ENV_KEYS]);
    await expect(
      decodeClaudeCliNodeRunParams(
        JSON.stringify({
          argv: sent?.argv,
          env: sent?.env,
          clearEnv: sent?.clearEnv,
          idleTimeoutMs: sent?.idleTimeoutMs,
          timeoutMs: sent?.timeoutMs,
        }),
      ),
    ).resolves.toMatchObject({ clearEnv: [...NODE_CLAUDE_CLEAR_ENV_KEYS] });
  });
});
