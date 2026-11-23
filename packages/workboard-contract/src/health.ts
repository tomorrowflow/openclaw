import type { WorkboardHealthFeed } from "./feed.js";

/** A health fact the Gateway could not read, with the reason. */
export type WorkboardHealthUnknown = { status: "unknown"; reason: string };

/**
 * One automation job the factory depends on: a board's `automationJobId`, or a
 * job run by a board's `defaultAssignee` or the calling agent. A job a board
 * names that the scheduler does not know carries no run facts.
 */
export type WorkboardHealthAutomation = {
  id: string;
  /** Boards whose `automationJobId` is this job. */
  boardIds: string[];
} & (
  | { exists: false }
  | {
      exists: true;
      name?: string;
      agentId?: string;
      enabled: boolean;
      lastRunStatus?: "ok" | "error" | "skipped";
      lastRunAt?: number;
      /** The last run's error, else its delivery error. */
      lastError?: string;
      nextRunAt?: number;
      runningSince?: number;
      /** Failed runs in a row; 0 after a success. */
      consecutiveErrors?: number;
      /** A trigger job's last evaluation, fired or not: `lastRunAt` moves only when a run fires or fails. */
      lastTriggerEvalAt?: number;
      triggerEvalCount?: number;
    }
);

/** One node a board's targets name: paired with its liveness, or not paired at all. */
export type WorkboardHealthNode = {
  nodeId: string;
  /** Boards whose default target or routes name this node. */
  boardIds: string[];
} & (
  | { paired: false }
  | { paired: true; displayName?: string; connected: boolean; lastSeenAt?: number }
);

/** An auth profile's usability for its provider: open, or closed until `until`. */
export type WorkboardHealthProfile = { profileId: string } & (
  | { status: "ok" }
  | { status: "cooldown" | "disabled" | "blocked"; until: number; reason?: string }
);

/** An agent's primary model and the stored profiles its provider can use. */
export type WorkboardHealthAccount = {
  agentId: string;
  provider: string;
  model: string;
  profiles: WorkboardHealthProfile[] | WorkboardHealthUnknown;
};

/**
 * `workboard.health`: the factory's operational state, projected at read time
 * for the boards' assignee agents, automation jobs, and node targets. Each
 * fact is `unknown` with a reason when its source could not be read.
 */
export type WorkboardHealthResult = {
  generatedAt: number;
  automations: WorkboardHealthAutomation[] | WorkboardHealthUnknown;
  nodes: WorkboardHealthNode[] | WorkboardHealthUnknown;
  accounts: WorkboardHealthAccount[] | WorkboardHealthUnknown;
  /** The board feed's posts since the Gateway started; absent before its first attempt. */
  feed?: WorkboardHealthFeed;
};
