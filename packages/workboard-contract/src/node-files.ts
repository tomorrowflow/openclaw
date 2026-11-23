// A node ticket's files of one kind (screenshots, prototypes, flow reports) and where they are read from.

/**
 * The files of one kind (screenshots, prototypes, or flow reports) a node ticket round added
 * or changed, read from its `to` commit on the host.
 */
export type WorkboardNodeFileRound = {
  round: number;
  commit: string;
  paths: string[];
};

/** The committed files, or why the host clone could not list them. */
export type WorkboardCommittedNodeFiles =
  | { state: "available"; rounds: WorkboardNodeFileRound[] }
  // Every round's commits are gone from the host clone (history rewritten or
  // branches pruned): nothing can be listed again, which is not a listing failure.
  | { state: "removed" }
  | { state: "unavailable"; reason: string };

/** A file the running agent wrote under one of the dirs listed for its kind, newest first. */
export type WorkboardLiveNodeFile = { path: string; bytes: number; mtimeMs: number };

/**
 * The files in the card's node worktree right now. `none`: the card has no
 * worktree on its node (not started yet, or its round was imported and the
 * worktree removed).
 */
export type WorkboardLiveNodeFiles =
  | { state: "available"; files: WorkboardLiveNodeFile[] }
  | { state: "unavailable"; reason: string }
  | { state: "none" };

/**
 * Committed files of a card the listed card references with a `relates_to`
 * link. Read one with that card's own id and the round and path listed here.
 */
export type WorkboardLinkedNodeFiles = {
  cardId: string;
  title: string;
  committed: WorkboardCommittedNodeFiles;
};

/**
 * The card's own files: `committed` rounds, and `live` files the running round
 * added or changed in its node worktree (files inherited from the base branch
 * are not listed). Each source fails on its own, so a node outage still shows
 * the committed rounds. `live` is present only when the list asked for it with
 * `live: true`. `linked` holds the committed files of the cards this one
 * references through `relates_to` links, in link order; it is absent when no
 * linked card has any.
 */
export type WorkboardNodeFileListResult = {
  committed: WorkboardCommittedNodeFiles;
  live?: WorkboardLiveNodeFiles;
  linked?: WorkboardLinkedNodeFiles[];
};

/**
 * One file: a round's committed file, a live file in the node worktree, or
 * the file on the repository's default branch in the Gateway host clone.
 */
export type WorkboardNodeFileSource = { round: number } | { live: true } | { base: true };

/**
 * Where a card shows one path from: `source` read with `cardId` (a linked
 * card's id; absent for the card's own). No `source` means the path is in
 * none of the card's sources.
 */
export type WorkboardNodeFileLocation = {
  path: string;
  cardId?: string;
  source?: WorkboardNodeFileSource;
};

/** How many paths one locate call takes. */
export const WORKBOARD_MAX_LOCATED_FILES = 200;

export type WorkboardNodeFileLocateResult = { files: WorkboardNodeFileLocation[] };

export type WorkboardScreenshotResult = { mimeType: string; contentBase64: string };

/** A prototype or flow report HTML file, decoded as UTF-8. */
export type WorkboardPrototypeResult = { html: string };
