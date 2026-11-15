import type { WorkboardCard } from "@openclaw/workboard-contract";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { isCronSessionKey } from "openclaw/plugin-sdk/routing";
import type { OpenClawPluginService } from "../api.js";
import { workboardCardStage } from "./card-stage.js";
import { nodeTicketTarget } from "./node-ticket.js";
import { cardBoardId } from "./store-card-helpers.js";
import { MAX_CARDS } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_AUTOMATION_NUDGE_DEBOUNCE_MS = 60_000;
// Re-runs one cooldown apart while the job is still busy: covers an automation
// turn of 15 minutes, the longest the board jobs allow.
const WORKBOARD_AUTOMATION_NUDGE_MAX_RERUNS = 15;

type WorkboardAutomationNudgeInput = {
  cards: readonly WorkboardCard[];
  sessionKey?: string;
  /** An operator comment can ask anything of the automation, so it always runs it. */
  operatorComment?: boolean;
};

type WorkboardAutomationNudgeService = OpenClawPluginService & {
  stop: () => void;
  nudge: (input: WorkboardAutomationNudgeInput) => Promise<void>;
};

type PendingBoardNudge = {
  timer?: ReturnType<typeof setTimeout>;
  rerun?: boolean;
  /** Whether the rerun waits for a node ticket that needs the automation. */
  rerunGated?: boolean;
  rerunCount: number;
};

type NudgeOwner = Pick<Parameters<OpenClawPluginService["start"]>[0], "logger" | "getCron">;

type WorkboardAutomationNudgeState = {
  owner?: NudgeOwner;
  pendingByBoard: Map<string, PendingBoardNudge>;
};

const WORKBOARD_AUTOMATION_NUDGE_STATE_KEY = Symbol.for("openclaw.workboard.automationNudgeState");

// Prepared model generations register fresh hook closures without starting their services.
// Shared state lets those closures reach the active service owner and its debounce fence.
function clearPendingBoardNudges(state: WorkboardAutomationNudgeState): void {
  for (const pending of state.pendingByBoard.values()) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
  }
  state.pendingByBoard.clear();
}

function getWorkboardAutomationNudgeState(): WorkboardAutomationNudgeState {
  return resolveGlobalSingleton<WorkboardAutomationNudgeState>(
    WORKBOARD_AUTOMATION_NUDGE_STATE_KEY,
    () => ({ pendingByBoard: new Map() }),
    (state) => {
      state.owner = undefined;
      clearPendingBoardNudges(state);
    },
  );
}

function isCronOriginSession(sessionKey: string | undefined): boolean {
  const normalized = sessionKey?.trim();
  // Cron keys are raw `cron:*` before store canonicalization and agent-scoped
  // `agent:*:cron:*:run:*` afterward; accepting either here would self-trigger.
  return normalized?.startsWith("cron:") === true || isCronSessionKey(normalized);
}

/**
 * Whether a node ticket waits on the board automation: questions not yet
 * escalated, or an imported round whose verifications ended without a verdict.
 * Every other node ticket turn end (a running round, a verdict awaiting the
 * operator) would only wake a review job that finds nothing to do.
 */
function nodeTicketNeedsAutomation(card: WorkboardCard): boolean {
  const stage = workboardCardStage(card);
  switch (stage?.kind) {
    case "questions":
      return stage.escalatedAt === undefined;
    case "reviewing":
      return true;
    case "review_incomplete":
      return stage.missing.includes("verdict");
    default:
      return false;
  }
}

export function createWorkboardAutomationNudgeService(params: {
  store: WorkboardStore;
}): WorkboardAutomationNudgeService {
  let serviceOwner: NudgeOwner | undefined;

  const nudgeBoard = async (
    boardId: string,
    jobId: string,
    owner: NudgeOwner,
    rerunCount: number,
    gated: boolean,
  ) => {
    const state = getWorkboardAutomationNudgeState();
    if (state.owner !== owner) {
      return;
    }
    const existing = state.pendingByBoard.get(boardId);
    if (existing) {
      // A node ticket's done report nudges at agent_end, and its import reaches
      // review moments later; the automation must still see the review.
      existing.rerunGated = (existing.rerunGated ?? true) && gated;
      existing.rerun = true;
      return;
    }
    if (state.pendingByBoard.size >= MAX_CARDS) {
      owner.logger.warn(
        `workboard automation nudge skipped for board ${boardId}: debounce map full`,
      );
      return;
    }
    const pending: PendingBoardNudge = { rerunCount };
    const expiresAt = performance.now() + WORKBOARD_AUTOMATION_NUDGE_DEBOUNCE_MS;
    // The board entry owns both the in-flight request and its cooldown, so a
    // second lifecycle event can never overlap the first automation run request.
    state.pendingByBoard.set(boardId, pending);
    try {
      const enqueueRun = owner.getCron?.()?.enqueueRun;
      if (!enqueueRun) {
        throw new Error("Workboard automation scheduler is unavailable");
      }
      // Read the board now, not the event's card: lifecycle hooks pass the card
      // as it was before their write.
      if (gated && !(await params.store.list({ boardId })).some(nodeTicketNeedsAutomation)) {
        owner.logger.info(
          `workboard automation nudge skipped for board ${boardId}: no node ticket waits on job ${jobId}`,
        );
        return;
      }
      const result = await enqueueRun(jobId, "if-enabled");
      if (!result.ok || ("ran" in result && !result.ran)) {
        const reason = "reason" in result ? result.reason : "not-run";
        // The busy run may have read the board before this event's card changed.
        if (reason === "already-running" && rerunCount < WORKBOARD_AUTOMATION_NUDGE_MAX_RERUNS) {
          pending.rerun = true;
          pending.rerunGated = gated;
        }
        owner.logger.warn(
          `workboard automation nudge skipped for board ${boardId}: job ${jobId} ${reason}`,
        );
        return;
      }
      const runId = "runId" in result ? result.runId : undefined;
      owner.logger.info(
        `workboard automation nudge requested for board ${boardId}: job ${jobId}${runId ? ` run ${runId}` : ""}`,
      );
    } catch (error) {
      // The automation schedule is the backstop; a nudge failure must not alter
      // lifecycle synchronization or card state.
      owner.logger.warn(`workboard automation nudge failed for board ${boardId}: ${String(error)}`);
    } finally {
      if (state.owner === owner && state.pendingByBoard.get(boardId) === pending) {
        pending.timer = setTimeout(
          () => {
            if (state.pendingByBoard.get(boardId) === pending) {
              state.pendingByBoard.delete(boardId);
              if (pending.rerun) {
                // Reread the board: its automation may have changed or gone meanwhile.
                void nudgeBoards(
                  new Map([[boardId, pending.rerunGated !== false]]),
                  owner,
                  pending.rerunCount + 1,
                );
              }
            }
          },
          Math.max(0, expiresAt - performance.now()),
        );
        pending.timer.unref?.();
      }
    }
  };

  /** Each board with whether its nudge waits for a node ticket that needs it. */
  const nudgeBoards = async (
    gatedByBoard: ReadonlyMap<string, boolean>,
    owner: NudgeOwner,
    rerunCount: number,
  ) => {
    try {
      const automationByBoard = new Map(
        (await params.store.listBoards()).boards.flatMap((board) =>
          board.automationJobId ? [[board.id, board.automationJobId] as const] : [],
        ),
      );
      await Promise.all(
        [...gatedByBoard].flatMap(([boardId, gated]) => {
          const jobId = automationByBoard.get(boardId);
          return jobId ? [nudgeBoard(boardId, jobId, owner, rerunCount, gated)] : [];
        }),
      );
    } catch (error) {
      owner.logger.warn(`workboard automation nudge failed: ${String(error)}`);
    }
  };

  return {
    id: "workboard-automation-nudge",
    start(ctx) {
      const state = getWorkboardAutomationNudgeState();
      clearPendingBoardNudges(state);
      state.owner = serviceOwner = { logger: ctx.logger, getCron: ctx.getCron };
    },
    stop() {
      const state = getWorkboardAutomationNudgeState();
      if (state.owner !== serviceOwner) {
        return;
      }
      state.owner = serviceOwner = undefined;
      clearPendingBoardNudges(state);
    },
    async nudge(input) {
      const state = getWorkboardAutomationNudgeState();
      const owner = state.owner;
      // Only the operator answers a grilling question, and nobody reviews a probe,
      // so neither gives the automation anything to do.
      const cards = input.cards.filter(
        (card) =>
          workboardCardStage(card)?.kind !== "grilling" && !card.metadata?.automation?.probe,
      );
      if (!owner || isCronOriginSession(input.sessionKey) || cards.length === 0) {
        return;
      }
      // Only node ticket turn ends are gated: any other card's event may be what
      // its board's automation (categorizing, triage) is for.
      const gatedByBoard = new Map<string, boolean>();
      for (const card of cards) {
        const boardId = cardBoardId(card);
        const gated = !input.operatorComment && nodeTicketTarget(card) !== undefined;
        gatedByBoard.set(boardId, (gatedByBoard.get(boardId) ?? true) && gated);
      }
      await nudgeBoards(gatedByBoard, owner, 0);
    },
  };
}
