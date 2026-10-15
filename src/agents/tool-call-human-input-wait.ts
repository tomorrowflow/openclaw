import { resolveGlobalMap } from "../shared/global-singleton.js";

/** Called when a wait starts; the returned callback runs once when that wait ends. */
type ToolCallHumanInputWaitObserver = () => () => void;

// Harness watchdogs observe this by tool call id; duplicated runtime chunks share one map.
const observersByToolCallId = resolveGlobalMap<string, Set<ToolCallHumanInputWaitObserver>>(
  Symbol.for("openclaw.toolCallHumanInputWaitObservers"),
  "close-and-restart",
);

/**
 * Lets a per-call execution watchdog stop counting while the call waits on a
 * human (a plugin approval). Waits that started before observing are not replayed.
 */
export function observeToolCallHumanInputWaits(
  toolCallId: string,
  observer: ToolCallHumanInputWaitObserver,
): () => void {
  let observers = observersByToolCallId.get(toolCallId);
  if (!observers) {
    observers = new Set();
    observersByToolCallId.set(toolCallId, observers);
  }
  observers.add(observer);
  return () => {
    const current = observersByToolCallId.get(toolCallId);
    if (current?.delete(observer) && current.size === 0) {
      observersByToolCallId.delete(toolCallId);
    }
  };
}

/** Marks the call as waiting on a human until the returned callback runs. */
export function beginToolCallHumanInputWait(toolCallId: string | undefined): () => void {
  const observers = toolCallId ? observersByToolCallId.get(toolCallId) : undefined;
  if (!observers) {
    return () => {};
  }
  const ends = [...observers].map((observer) => observer());
  let ended = false;
  return () => {
    if (ended) {
      return;
    }
    ended = true;
    for (const end of ends) {
      end();
    }
  };
}
