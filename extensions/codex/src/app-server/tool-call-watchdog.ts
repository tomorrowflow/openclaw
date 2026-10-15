import { observeToolCallHumanInputWaits } from "openclaw/plugin-sdk/agent-harness-runtime";

export type ToolCallWatchdog = {
  /** Restart the budget from now (still paused while a human wait is open). */
  reset: (timeoutMs: number) => void;
  dispose: () => void;
};

/**
 * One-shot per-call timer whose clock stops while the call waits on a human,
 * such as a plugin approval: that wait has its own bounded deadline, and
 * counting it here would cancel approvals at the tool budget instead.
 */
export function startToolCallWatchdog(params: {
  toolCallId: string | undefined;
  timeoutMs: number;
  onTimeout: () => void;
}): ToolCallWatchdog {
  let remainingMs = params.timeoutMs;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let openWaits = 0;
  let disposed = false;
  const run = () => {
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = undefined;
      disposed = true;
      unobserve();
      params.onTimeout();
    }, remainingMs);
    timer.unref?.();
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const unobserve = params.toolCallId
    ? observeToolCallHumanInputWaits(params.toolCallId, () => {
        if (disposed) {
          return () => {};
        }
        if (openWaits++ === 0 && timer) {
          stop();
          remainingMs = Math.max(1, remainingMs - (Date.now() - startedAt));
        }
        return () => {
          if (--openWaits === 0 && !disposed) {
            run();
          }
        };
      })
    : () => {};
  run();
  return {
    reset: (timeoutMs) => {
      if (disposed) {
        return;
      }
      stop();
      remainingMs = timeoutMs;
      if (openWaits === 0) {
        run();
      }
    },
    dispose: () => {
      disposed = true;
      stop();
      unobserve();
    },
  };
}
