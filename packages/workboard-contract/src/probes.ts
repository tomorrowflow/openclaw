import type { WorkboardStatus, WorkboardVerificationVerdict } from "./index.js";

/**
 * A probe card re-runs a past node ticket (`of`) from that ticket's base
 * commit under a named harness `arm`, so two arms of one card contrast the
 * harness on a fixed task. A probe never publishes, no agent moves it, and the
 * trust KPIs leave it out; the handoff pass archives it once its round ends.
 * Set only by `workboard.cards.probe`.
 */
export type WorkboardProbe = {
  of: string;
  arm: string;
  createdAt: number;
};

/**
 * How a probe's round ended: `done` once it imported (and its verification
 * finished), `needs_input` or `grill` when it stopped to ask, `blocked`, or
 * `running` while it has not ended yet.
 */
export type WorkboardProbeOutcome = "done" | "needs_input" | "grill" | "blocked" | "running";

/** One probe card of `workboard.cards.probes`. */
export type WorkboardProbeRow = {
  /** The source card the probe re-runs, its title, and how its own tickets fared. */
  of: string;
  ofTitle?: string;
  /** From the same facts as the trust KPIs; absent when the source card is gone. */
  source?: { accepted: boolean; clean: boolean; reworkRounds: number };
  arm: string;
  cardId: string;
  status: WorkboardStatus;
  outcome: WorkboardProbeOutcome;
  verification?: { verdict: WorkboardVerificationVerdict; findings: number; model?: string };
  attempts: number;
  /** The largest turn-end context of its runs. */
  maxContextTokens?: number;
  /** From its first run's start to its last run's end, once it ended. */
  runTimeMs?: number;
  /** The target model it ran on, when one is pinned. */
  model?: string;
};

/** `workboard.cards.probes`: a board's probe cards, grouped by source card, then by arm. */
export type WorkboardProbesResult = {
  boardId: string;
  generatedAt: number;
  probes: WorkboardProbeRow[];
};
