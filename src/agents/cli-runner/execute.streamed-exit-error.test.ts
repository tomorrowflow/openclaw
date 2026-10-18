/** A streamed CLI run that exits in failure reports the failure, never the stream chatter before it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  setCliRunnerExecuteTestDeps,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

vi.mock("../../process/supervisor/adapters/child.js", () => ({ createChildAdapter: vi.fn() }));

type SupervisorSpawnInput = Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

afterEach(() => {
  vi.restoreAllMocks();
});

const SESSION_ID = "2e33ff7b-1567-4402-a6d1-9e59b1a943b3";
const DENIAL = "Permission to use Bash with command echo hi has been denied.";
const NODE_WARNING = "(node:4242) Warning: something deprecated";

// Recorded from `claude -p --output-format stream-json --verbose` (Claude Code
// 2.1.x) under a `permissions.deny` rule. The denial is a tool result the model
// recovers from; the `permission_denied` system record repeats it as `message`.
const deniedThenRecoveredStream = [
  {
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    tools: ["Bash", "Read"],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
  },
  {
    type: "assistant",
    message: {
      id: "msg_01",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_01denied", name: "Bash", input: { command: "echo hi" } },
      ],
      stop_reason: "tool_use",
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  },
  {
    type: "system",
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: "toolu_01denied",
    decision_reason_type: "subcommandResults",
    message: DENIAL,
    session_id: SESSION_ID,
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", content: DENIAL, is_error: true, tool_use_id: "toolu_01denied" },
      ],
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    tool_use_result: `Error: ${DENIAL}`,
    tool_result_meta: [
      {
        id: "toolu_01denied",
        non_execution_kind: "permission-rule",
        permission_decision: { decision: "reject", source: "config" },
      },
    ],
  },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: SESSION_ID },
  {
    type: "assistant",
    message: {
      id: "msg_02",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_02ok", name: "Bash", input: { command: "printf hi" } },
      ],
      stop_reason: "tool_use",
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: "toolu_02ok", type: "tool_result", content: "hi", is_error: false }],
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    tool_use_result: { stdout: "hi", stderr: "", interrupted: false },
  },
];

const errorResult = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  session_id: SESSION_ID,
  stop_reason: "error",
  result: "",
  errors: ["API Error: 529 Overloaded"],
};

function jsonl(records: readonly Record<string, unknown>[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function mockNodeRun(
  records: readonly Record<string, unknown>[],
  outcome: Awaited<ReturnType<typeof invokeNodeClaudeCliRun>>,
) {
  const invokeNode = vi.fn(async (params: Parameters<typeof invokeNodeClaudeCliRun>[0]) => {
    params.onProgress(jsonl(records));
    return outcome;
  });
  setCliRunnerExecuteTestDeps({ invokeNodeClaudeCliRun: invokeNode });
}

function nodeRunContext() {
  return buildPreparedCliRunContext({
    sessionEntry: {
      sessionId: "openclaw-session",
      updatedAt: 1,
      execHost: "node",
      execNode: "node-a",
    },
  });
}

function mockSpawn(stdout: string, exit: { exitCode: number; stderr: string }) {
  supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
    const input = args[0] as SupervisorSpawnInput;
    input.onStdout?.(stdout);
    input.onStderr?.(exit.stderr);
    return createManagedRun({ ...createSuccessfulProcessExit(), ...exit });
  });
}

describe("paired-node Claude run that fails after a denied tool result", () => {
  it("reports the node disconnect, not the denial the model already recovered from", async () => {
    mockNodeRun(deniedThenRecoveredStream, {
      ok: false,
      error: { code: "DISCONNECTED", message: "node disconnected (anthropic.claude.run)" },
    });

    const failure = await executePreparedCliRun(nodeRunContext()).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "FailoverError",
      message: "node disconnected (anthropic.claude.run)",
      // The stream's rate_limit_event must not put the auth profile in cooldown.
      reason: "unknown",
    });
  });

  it("keeps the CLI's own error result ahead of stderr noise on a non-zero exit", async () => {
    mockNodeRun([...deniedThenRecoveredStream, errorResult], {
      ok: true,
      payloadJSON: JSON.stringify({ exitCode: 1, stderrTail: NODE_WARNING, truncated: false }),
    });

    await expect(executePreparedCliRun(nodeRunContext())).rejects.toMatchObject({
      message: "API Error: 529 Overloaded",
      reason: "overloaded",
    });
  });
});

describe("spawned stream-json run that exits non-zero", () => {
  it("names the stderr cause when the stream ended without a result", async () => {
    mockSpawn(jsonl(deniedThenRecoveredStream), { exitCode: 1, stderr: "Segmentation fault" });

    await expect(executePreparedCliRun(buildPreparedCliRunContext())).rejects.toMatchObject({
      message: "Segmentation fault",
      reason: "unknown",
    });
  });

  it("still mines stdout error records for a jsonl backend without a parser-owned dialect", async () => {
    mockSpawn(jsonl([{ type: "error", message: "model not found: foo" }]), {
      exitCode: 1,
      stderr: "",
    });

    await expect(
      executePreparedCliRun(
        buildPreparedCliRunContext({ provider: "codex-cli", backend: { output: "jsonl" } }),
      ),
    ).rejects.toMatchObject({ message: "model not found: foo", reason: "model_not_found" });
  });
});
