/**
 * One session that worked on a card, for the operator's session list. Derived
 * on operator reads and never stored. `round` is the node ticket round (0 for
 * the first run, and for cards without rounds). A `blind` row is the verifier,
 * cross-verifier, or verdict of a round the operator has not decided yet: its
 * session key stays out of operator reads until the decision.
 */
export type WorkboardCardSession = {
  role: "implementer" | "verifier" | "cross_verifier" | "verdict" | "grill";
  round: number;
  state: "running" | "finished";
} & ({ sessionKey: string } | { blind: true });
