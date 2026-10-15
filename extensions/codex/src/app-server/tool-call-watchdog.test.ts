import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDynamicToolCallWithTimeout } from "./dynamic-tool-execution.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { RpcResponse } from "./protocol.js";
import { CodexServerRequests } from "./server-requests.js";

type WaitObserver = () => () => void;

const observers = new Map<string, WaitObserver>();

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importActual) => ({
  ...(await importActual<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  observeToolCallHumanInputWaits: (toolCallId: string, observer: WaitObserver) => {
    observers.set(toolCallId, observer);
    return () => observers.delete(toolCallId);
  },
}));

function startCall(callId: string) {
  let settled = false;
  let finish: ((response: CodexDynamicToolRuntimeResponse) => void) | undefined;
  const response = handleDynamicToolCallWithTimeout({
    call: {
      threadId: "thread-1",
      turnId: "turn-1",
      namespace: null,
      callId,
      tool: "comfyui__download_model",
      arguments: {},
    },
    toolBridge: {
      consumeToolExecutionSnapshot: () => undefined,
      handleToolCall: () =>
        new Promise<CodexDynamicToolRuntimeResponse>((resolve) => {
          finish = resolve;
        }),
    },
    signal: new AbortController().signal,
    timeoutMs: 90_000,
  }).finally(() => {
    settled = true;
  });
  return {
    response,
    isSettled: () => settled,
    finish: (r: CodexDynamicToolRuntimeResponse) => finish?.(r),
  };
}

describe("codex dynamic tool watchdog during human input waits", () => {
  afterEach(() => {
    vi.useRealTimers();
    observers.clear();
  });

  it("does not count a pending approval against the tool budget", async () => {
    vi.useFakeTimers();
    const call = startCall("call-approval");
    await vi.advanceTimersByTimeAsync(10_000);
    const endWait = observers.get("call-approval")?.();
    // A five-minute approval wait outlasts the 90s budget without timing out.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(call.isSettled()).toBe(false);
    endWait?.();
    call.finish({ success: true, contentItems: [{ type: "inputText", text: "downloaded" }] });
    await expect(call.response).resolves.toMatchObject({ success: true });
  });

  it("keeps the remaining budget once the approval resolves", async () => {
    vi.useFakeTimers();
    const call = startCall("call-resume");
    await vi.advanceTimersByTimeAsync(60_000);
    const endWait = observers.get("call-resume")?.();
    await vi.advanceTimersByTimeAsync(300_000);
    endWait?.();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(call.isSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(call.response).resolves.toMatchObject({ success: false });
    expect(observers.has("call-resume")).toBe(false);
  });

  it("keeps the app-server request guard open while the approval waits", async () => {
    vi.useFakeTimers();
    const responses: RpcResponse[] = [];
    const requests = new CodexServerRequests((response) => responses.push(response));
    let finish: ((value: { success: boolean; contentItems: never[] }) => void) | undefined;
    requests.handlers.add((_request, _signal, setExecutionTimeoutMs) => {
      setExecutionTimeoutMs?.(90_000);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const handled = requests.handle({
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-guard",
        tool: "comfyui__download_model",
        arguments: {},
      },
    });
    const endWait = observers.get("call-guard")?.();
    // The guard is 90s + 30s; a five-minute approval must not trip it.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(responses).toEqual([]);
    endWait?.();
    finish?.({ success: true, contentItems: [] });
    await handled;
    expect(responses).toEqual([{ id: 1, result: { success: true, contentItems: [] } }]);
  });
});
