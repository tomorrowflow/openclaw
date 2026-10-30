import type { WorkboardMergeRegression, WorkboardRung } from "./index.js";

/**
 * The dev loop trust KPIs (D9/D53), projected from node ticket cards on read.
 * The Workboard plugin owns the projection.
 */

/** Trust KPI counts for one task class or for all node tickets (dev loop D9/D53). */
export type WorkboardTrustCounts = {
  /** Node tickets in scope, archived ones included. */
  tickets: number;
  /** Published as a draft PR, i.e. accepted at least once. */
  accepted: number;
  /** Accepted with no rework round, no outside commit, and no operator-answered question. */
  cleanAccepted: number;
  /** Reached the import without ever being blocked. */
  firstPass: number;
  /** Blocked at least once (each block needed a person or a re-plan). */
  blocked: number;
  reworkRounds: number;
  outsideCommits: number;
  /** Answered needs_input rounds, and how many of them an operator answered. */
  questionRounds: number;
  operatorAnswers: number;
  attempts: number;
  /**
   * Operator-decided review rounds with an agent verdict, and how many matched
   * the operator: `accept` with no rework after the publish, or `rework` with one.
   */
  verdictRounds: number;
  verdictAgreedRounds: number;
  /** Tickets whose every round has a verdict, and those where every verdict matched. */
  verdictCards: number;
  verdictAgreedCards: number;
  /** Rounds published before any verdict; excluded from both rates. */
  verdictMissed: number;
  /** Missed rounds among the newest 10 operator-decided rounds, by publish time. */
  verdictMissedRecent: number;
  /** Rounds an agent accepted at rung b, and those a later rework round reopened. */
  agentAccepts: number;
  reworkedAccepts: number;
  /** Agent-accepted rounds in the human review sample, and those not reworked later. */
  sampledRounds: number;
  sampledAgreed: number;
  /** Runs with a recorded turn-end context, and those whose context passed the smart zone. */
  contextMeasured: number;
  smartZoneBreaches: number;
  /** Published rounds with a verification, and those whose verdict was `fail`. */
  verifiedRounds: number;
  verifierFailed: number;
  /**
   * Verified rounds a person decided without seeing the verification
   * (operator rounds that ran at rung a, and sampled agent accepts), those
   * where the verification matched that person (`pass` and no rework after
   * the publish, or not `pass` and a rework), the escapes (`pass` verdicts a
   * person then reworked), and the catches (`fail` or `error` verdicts a
   * person then reworked). An agent's rework after a `fail` agrees with
   * itself and is not scored; nor is an operator's decision on a rung b
   * round, where the verification was in view.
   */
  verifierScoredRounds: number;
  verifierAgreedRounds: number;
  verifierEscapes: number;
  verifierCatches: number;
  /**
   * Published rounds with both an operator visual check and a verifier visual
   * verdict other than `not_checked`, and those where the two agree.
   */
  visualRounds: number;
  visualAgreedRounds: number;
  /**
   * Merged tickets whose merge the regression watch found reverted or turning
   * the base branch red within 7 days, dismissed ones left out (D37).
   */
  regressions: number;
};

/** Accepted tickets in one UTC week (Monday 00:00), by acceptance time. */
export type WorkboardTrustWeek = {
  weekStart: number;
  accepted: number;
  /** Accepted with zero human touches: no rework, outside commit, or block. */
  autonomous: number;
  medianLeadTimeMs?: number;
  /** Median import-to-publish wait of the review rounds published this week. */
  medianReviewWaitMs?: number;
  /** Median turn-end context of the measured runs that ended this week. */
  medianContextTokens?: number;
};

/**
 * A class's counts over blind rounds: those published at or after
 * 2026-10-11 13:01 CEST, when the operator stopped seeing the agent's verdict
 * before deciding. A round an agent decided ran at the rung it recorded (b
 * when it predates rung c), every other round at rung a. A ticket is in a
 * rung when it has a blind round there, and
 * counts as accepted there when its first publish is one of them; its
 * ticket-wide facts (rework, blocks, attempts) come along whole.
 */
export type WorkboardTrustBlind = Partial<Record<WorkboardRung, WorkboardTrustCounts>>;

/**
 * A read-time projection of node ticket card facts, never stored. Task class
 * comes from a `class:<name>` label. Blocks are counted from card events,
 * which keep the newest 50 per card.
 */
export type WorkboardTrustResult = {
  boardId: string;
  generatedAt: number;
  /** A run's turn-end context above this many tokens is a smart-zone breach. */
  smartZoneTokens: number;
  total: WorkboardTrustCounts;
  /**
   * `rung` is the board's rung for the class; only a one-board projection has it.
   * `blind` counts only rounds published since the blind verdict went live,
   * split by the rung each round was decided at; see {@link WorkboardTrustBlind}.
   * `rungSince` is the class rung's `since`, and `sinceRung` counts only
   * rounds published at or after it; both need a one-board projection and a
   * rung with `since`.
   */
  classes: Array<
    WorkboardTrustCounts & {
      taskClass: string;
      rung?: WorkboardRung;
      rungSince?: number;
      sinceRung?: WorkboardTrustCounts;
      blind: WorkboardTrustBlind;
    }
  >;
  /** The last 8 weeks, oldest first, including the current one. */
  weeks: WorkboardTrustWeek[];
};

/** One merged PR whose last round an agent accepted at rung c (D37 digest). */
export type WorkboardMergeDigestEntry = {
  cardId: string;
  title: string;
  /** The PR's repository, `owner/name`. */
  repo: string;
  pullRequestUrl: string;
  mergedAt: number;
  mergeCommit: string;
  /** Workboard merged it; otherwise someone merged it by hand. */
  autoMerged: boolean;
  /** The round was in the human review sample; `readAt` is when it was read. */
  sampled?: true;
  readAt?: number;
  regression?: WorkboardMergeRegression;
  /** Undoes the merge from a checkout of `repo` on its base branch. */
  revertCommand: string;
};

/**
 * What merged at rung c in a window, per task class, projected from node
 * ticket cards on read. `text` is the same digest as Markdown, for a packet
 * or message that posts it as is.
 */
export type WorkboardMergeDigestResult = {
  boardId: string;
  since: number;
  generatedAt: number;
  classes: Array<{ taskClass: string; merges: WorkboardMergeDigestEntry[] }>;
  text: string;
};
