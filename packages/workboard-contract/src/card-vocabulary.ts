// The values a card itself takes: where it stands, how urgent it is, what it is for.
export const WORKBOARD_STATUSES = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;

export const WORKBOARD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
/**
 * What a card is for, which decides its workflow: a `task` builds or changes
 * something, a `spec` grills and writes a spec with its tickets, a `prototype`
 * settles a design question with a throwaway, `research` answers a question in
 * writing, a `bug` reproduces a fault before fixing it, and a `retro` is the
 * operator's review of the loop, held in chat and never started. A card
 * without a kind is a task.
 */
export const WORKBOARD_CARD_KINDS = [
  "task",
  "spec",
  "prototype",
  "research",
  "bug",
  "retro",
] as const;

export type WorkboardStatus = (typeof WORKBOARD_STATUSES)[number];
export type WorkboardPriority = (typeof WORKBOARD_PRIORITIES)[number];
export type WorkboardCardKind = (typeof WORKBOARD_CARD_KINDS)[number];
