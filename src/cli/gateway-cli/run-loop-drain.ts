import {
  markGatewayRestartTrace,
  measureGatewayRestartTrace,
} from "../../gateway/restart-trace.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayDrainReason } from "../../process/gateway-work-admission.js";
import type { GatewayRunSignalAction, GatewayRunSignalRequest } from "./run-loop-request.js";
import { formatDrainCounts, formatShutdownReason } from "./run-loop-shutdown-format.js";

const RESTART_DRAIN_STILL_PENDING_WARN_MS = 30_000;

/**
 * True when every active embedded run is parked on an approval the draining
 * Gateway refuses, so waiting cannot let it finish. Shutdown then hands those
 * runs to restart recovery. Unattributed counts stay within what the parked runs
 * hold themselves (one reply and root request each, plus a session lane task
 * wrapping its global lane task), so another owner's in-flight delivery, lane
 * task, or request keeps the drain waiting.
 */
function isOnlyRestartBlockedRunWork(
  snapshot: GatewayActiveWorkSnapshot,
  runtime: Pick<
    typeof import("./lifecycle.runtime.js"),
    "listActiveEmbeddedRunSessionIds" | "isGatewayRestartBlockedSession"
  >,
): boolean {
  const { counts } = snapshot;
  if (
    counts.embeddedRuns === 0 ||
    counts.agentRuns > counts.embeddedRuns ||
    counts.sessionAdmissions > counts.embeddedRuns ||
    counts.pendingReplies > counts.embeddedRuns ||
    counts.rootRequests > counts.embeddedRuns ||
    counts.chatRuns > counts.embeddedRuns ||
    counts.queueSize > 2 * counts.embeddedRuns ||
    counts.backgroundExecSessions +
      counts.cronRuns +
      counts.acpRuns +
      counts.mediaRuns +
      counts.sessionMutations +
      counts.terminalPersistence +
      counts.terminalSessions +
      counts.lifecycleWrites >
      0
  ) {
    return false;
  }
  const sessionIds = runtime.listActiveEmbeddedRunSessionIds();
  return (
    sessionIds.length >= counts.embeddedRuns &&
    sessionIds.every((sessionId) => runtime.isGatewayRestartBlockedSession(sessionId))
  );
}

export async function drainGatewayActiveWork({
  request,
  runtime,
  drainTimeoutMs,
  restartDrainDeadlineAt,
  markDraining,
  recordCounts,
  recordWarning,
  logger,
}: {
  request: GatewayRunSignalRequest;
  runtime: typeof import("./lifecycle.runtime.js");
  drainTimeoutMs: number | undefined;
  restartDrainDeadlineAt: number | undefined;
  markDraining: (reason: GatewayDrainReason) => void;
  recordCounts: (counts: string) => void;
  recordWarning: (warning: string) => void;
  logger: Pick<SubsystemLogger, "info" | "warn">;
}): Promise<{ releasedBlockedRuns: boolean }> {
  const { restartIntent } = request;
  const reportDrainSnapshot = createGatewayDrainReporter(
    request.action,
    drainTimeoutMs,
    runtime,
    logger,
    recordCounts,
  );
  // On restart, wait for the canonical process activity inventory before
  // tearing down the server so active work can settle.
  if (request.action !== "stop") {
    let activeWorkAtDrainStart = 0;
    let activeRunsAtDrainStart = 0;
    let drainTimedOut = false;
    let approvalBlocked = false;
    await measureGatewayRestartTrace(
      "restart.drain",
      async () => {
        const { abortEmbeddedAgentRun, createGatewayActiveWorkSnapshot, waitForGatewayActiveWork } =
          runtime;
        // Reject new enqueues immediately during the drain window so
        // sessions get an explicit restart error instead of silent task loss.
        markDraining(formatShutdownReason(request));
        const initialSnapshot = createGatewayActiveWorkSnapshot();
        activeWorkAtDrainStart = initialSnapshot.counts.totalActive;
        activeRunsAtDrainStart = initialSnapshot.counts.embeddedRuns;
        if (activeRunsAtDrainStart > 0) {
          abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" });
        }

        reportDrainSnapshot(initialSnapshot);
        const remainingDrainTimeoutMs =
          restartDrainDeadlineAt === undefined
            ? undefined
            : Math.max(0, restartDrainDeadlineAt - Date.now());
        const drain = await waitForGatewayActiveWork(remainingDrainTimeoutMs, {
          onSnapshot: reportDrainSnapshot,
          release: (snapshot) => isOnlyRestartBlockedRunWork(snapshot, runtime),
        });
        if (drain.drained) {
          if (!initialSnapshot.idle) {
            logger.info("all active work drained");
          }
          return;
        }
        if (drain.released) {
          approvalBlocked = true;
          const warning = `restart drain ended early: remaining run(s) are parked on approvals the restarting gateway cannot grant; handing them to restart recovery ${formatDrainCounts(drain.snapshot)}`;
          recordWarning(warning);
          logger.warn(warning);
          return;
        }
        drainTimedOut = true;
        const warning = `restart drain budget ${drainTimeoutMs}ms exhausted; cutting short ${formatDrainCounts(drain.snapshot)}`;
        recordWarning(warning);
        logger.warn(warning);
        // Connection work can retain cron cleanup; cancel before close joins it.
        runtime.abortActiveCronTaskRuns("Gateway restarting.");
      },
      () => [
        ["activeWork", activeWorkAtDrainStart],
        ["activeRuns", activeRunsAtDrainStart],
        ["timedOut", drainTimedOut],
        ["approvalBlocked", approvalBlocked],
        ["force", restartIntent?.force === true],
      ],
    );
    // Close-stage reply drain must not wait again for runs this drain released.
    return { releasedBlockedRuns: approvalBlocked };
  }
  // Keep all process-owned work alive without spending the shutdown reserve
  // that server teardown and the supervisor watchdog need.
  try {
    markGatewayRestartTrace("stop.drain.begin");
    const activeWorkDrain = await measureGatewayRestartTrace("stop.drain", () =>
      runtime.waitForGatewayActiveWork(drainTimeoutMs, {
        onSnapshot: reportDrainSnapshot,
      }),
    );
    if (!activeWorkDrain.drained) {
      logger.warn(
        `gateway active-work drain timeout reached; proceeding with shutdown: ${formatDrainCounts(activeWorkDrain.snapshot)}`,
      );
      runtime.abortEmbeddedAgentRun(undefined, { mode: "all" });
      runtime.abortActiveCronTaskRuns("Gateway stopping.");
    }
  } catch (err) {
    logger.warn(
      `gateway active-work drain failed; proceeding with shutdown: ${formatErrorMessage(err)}`,
    );
  }
  logger.info("active-work drain settled; beginning server close");
  return { releasedBlockedRuns: false };
}

function createGatewayDrainReporter(
  action: GatewayRunSignalAction,
  drainTimeoutMs: number | undefined,
  runtime: Pick<
    typeof import("./lifecycle.runtime.js"),
    "listActiveEmbeddedRunSessionIds" | "getDiagnosticSessionActivitySnapshot"
  >,
  logger: Pick<SubsystemLogger, "info" | "warn">,
  recordCounts: (counts: string) => void,
) {
  const drainBudget =
    drainTimeoutMs === undefined ? "without a timeout" : `with timeout ${drainTimeoutMs}ms`;
  let lastPendingWarningAt: number | undefined;
  return (snapshot: GatewayActiveWorkSnapshot) => {
    recordCounts(formatDrainCounts(snapshot) || "no active work");
    const now = Date.now();
    if (lastPendingWarningAt === undefined) {
      lastPendingWarningAt = now;
      if (!snapshot.idle) {
        logger.info(
          `draining active work before ${action} ${drainBudget}: ${formatDrainCounts(snapshot)}`,
        );
        const requestTimeoutMs = Math.max(
          0,
          ...runtime
            .listActiveEmbeddedRunSessionIds()
            .map(
              (sessionId) =>
                runtime.getDiagnosticSessionActivitySnapshot({ sessionId })
                  ?.activeModelCallRequestTimeoutMs ?? 0,
            ),
        );
        if (requestTimeoutMs > 0) {
          logger.info(
            `largest observed model request timeout is ${requestTimeoutMs}ms; shutdown drain budget remains ${drainBudget}`,
          );
        }
      }
    } else if (
      !snapshot.idle &&
      now - lastPendingWarningAt >= RESTART_DRAIN_STILL_PENDING_WARN_MS
    ) {
      lastPendingWarningAt = now;
      logger.warn(`still draining active work before ${action}: ${formatDrainCounts(snapshot)}`);
    }
  };
}
