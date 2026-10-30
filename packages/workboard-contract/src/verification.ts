/**
 * The independent verification of a node ticket's imported round: the
 * board's verifier settings, the record a run leaves on the node worktree,
 * and its verdict. The Workboard plugin owns the lifecycle.
 */

/** The board's verifier: a session of `agentId` on `model` (`provider/model`). */
export type WorkboardVerifierSettings = {
  agentId: string;
  model: string;
};

/**
 * `pass`: the proof re-ran and nothing broke; `fail`: the verifier found a
 * defect; `error`: the run could not finish (no session, no report block).
 */
export type WorkboardVerificationVerdict = "pass" | "fail" | "error";

/** One finding of a verification: where it is and what is wrong. */
export type WorkboardNodeVerificationFinding = {
  path: string;
  line?: number;
  body: string;
};

/**
 * The current round's verification: an independent session on the board's
 * `verifier` model re-runs the imported round's proof in a detached worktree
 * of `headCommit` on the ticket's node and tries to break the change. A
 * `running` record holds the card's node-ticket slot; a `done` record with
 * `verdict: "pass"` is what an agent's accept at rung b or c needs. A record
 * whose `headCommit` or `round` is not the imported round's is stale and
 * ignored. The next round's import replaces it; `workboard.cards.verify` drops
 * a `done` record so the handoff pass runs a fresh one. The board's
 * `crossVerifier` writes the same record to `crossVerification`.
 */
export type WorkboardNodeVerification =
  | {
      phase: "running";
      round: number;
      headCommit: string;
      startedAt: number;
      sessionKey: string;
      /** The detached verify worktree on the node; removed when the run settles. */
      path: string;
      model?: string;
    }
  | {
      phase: "done";
      round: number;
      headCommit: string;
      startedAt: number;
      endedAt: number;
      sessionKey?: string;
      model?: string;
      verdict: WorkboardVerificationVerdict;
      summary: string;
      /** Capped; the verifier's comment on the card carries the full list it posted. */
      findings: WorkboardNodeVerificationFinding[];
      /**
       * The verifier's visual read of the round. Shadow data while the visual
       * check is calibrated: card reads leave it out until `visualCheck` is
       * recorded, and it never changes `verdict`.
       */
      visual?: WorkboardNodeVisualRead;
      /** The operator's own visual check of the round; recording it reveals `visual`. */
      visualCheck?: WorkboardNodeVisualCheck;
    };

export type WorkboardVisualVerdict = "looks_right" | "problem";

export type WorkboardNodeVisualScreenshot = {
  path: string;
  shows: string;
  verdict: WorkboardVisualVerdict;
};

/**
 * The verifier's look at a UI round's screenshots: those it captured in its
 * verify worktree or the round committed, each with what it shows, and the
 * overall verdict. `not_checked` means the round had no screenshots to look
 * at or the session had no tool that shows an image; it is not an error. The
 * visual check is operator-run, so no visual verdict fails a verification.
 */
export type WorkboardNodeVisualRead = {
  verdict: WorkboardVisualVerdict | "not_checked";
  /** Capped. */
  screenshots: WorkboardNodeVisualScreenshot[];
};

/** The operator's own look at the round's screenshots, recorded with `workboard.cards.visualCheck`. */
export type WorkboardNodeVisualCheck = {
  verdict: WorkboardVisualVerdict;
  note?: string;
  at: number;
};
