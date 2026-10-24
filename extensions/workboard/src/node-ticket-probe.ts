import type {
  WorkboardCard,
  WorkboardNodeWorktree,
  WorkboardProbe,
  WorkboardProbeOutcome,
  WorkboardProbeRow,
  WorkboardProbesResult,
  WorkboardVerifierSettings,
} from "@openclaw/workboard-contract";
import { currentNodeVerification, nodeTicketTarget } from "./node-ticket.js";
import { cardBoardId } from "./store-card-helpers.js";
import type { WorkboardLinkedCreateInput } from "./store-inputs.js";
import { PROBE_ARM_PATTERN } from "./store-launch-normalizers.js";
import { workboardTicketOutcome } from "./trust-kpis.js";

const PROBE_LABEL = "probe";
const MAX_TITLE_CHARS = 180;

export type NodeProbeRequest = { arm: string; model?: string; note?: string };

/**
 * The probe card of `source` under `arm`: the source's title, notes, board,
 * assignee, and labels, with `note` as a last paragraph of the notes, so a
 * trial's brief line reaches one arm only. Its target is the source's node
 * target without the worktree, based on the commit the source started from,
 * on `model` when one is given. Throws the refusal the operator gets.
 */
export function nodeProbeCreate(
  source: WorkboardCard,
  request: NodeProbeRequest,
  now: number,
): { input: WorkboardLinkedCreateInput; probe: WorkboardProbe } {
  const { arm } = request;
  if (!PROBE_ARM_PATTERN.test(arm)) {
    throw new Error(`arm must match ${PROBE_ARM_PATTERN.source}.`);
  }
  const sourceProbe = source.metadata?.automation?.probe;
  if (sourceProbe) {
    throw new Error(`card ${source.id} is a probe; probe its source card ${sourceProbe.of}.`);
  }
  const target = nodeTicketTarget(source);
  if (!target?.worktree) {
    throw new Error(
      `card ${source.id} is not a node ticket that ran; only one with a recorded base commit can be probed.`,
    );
  }
  const { worktree, ...rest } = target;
  const notes = [source.notes?.trim(), request.note?.trim()].filter(Boolean).join("\n\n");
  return {
    probe: { of: source.id, arm, createdAt: now },
    input: {
      title: `[PROBE:${arm}] ${source.title}`.slice(0, MAX_TITLE_CHARS),
      ...(notes ? { notes } : {}),
      status: "todo",
      priority: source.priority,
      ...(source.agentId ? { agentId: source.agentId } : {}),
      // A trial label marks the source's own harness, which the arm replaces.
      labels: [
        ...source.labels.filter(
          (label) =>
            !label.startsWith("trial:") && label !== PROBE_LABEL && !label.startsWith("probe:"),
        ),
        PROBE_LABEL,
        `probe:${arm}`,
      ],
      boardId: cardBoardId(source),
      metadata: {
        automation: {
          target: {
            ...rest,
            baseRef: worktree.baseCommit,
            ...(request.model ? { model: request.model } : {}),
          },
        },
      },
    },
  };
}

/** The unarchived probe card of `of` under `arm`, which a repeated probe request returns. */
export function liveNodeProbe(
  cards: readonly WorkboardCard[],
  of: string,
  arm: string,
): WorkboardCard | undefined {
  return cards.find((card) => {
    const probe = card.metadata?.automation?.probe;
    return probe?.of === of && probe.arm === arm && !card.metadata?.archivedAt;
  });
}

export type NodeProbeEnd = {
  outcome: Exclude<WorkboardProbeOutcome, "blocked" | "running">;
  worktree: WorkboardNodeWorktree;
};

/**
 * A probe whose round ended and that the handoff pass archives: imported with
 * its verification finished (or no verifier to wait for), or stopped with
 * questions or a grilling, which a probe never gets answered.
 */
export function nodeProbeEnd(
  card: WorkboardCard,
  verifier: WorkboardVerifierSettings | undefined,
): NodeProbeEnd | undefined {
  const worktree = nodeTicketTarget(card)?.worktree;
  const phase = worktree?.handoff?.phase;
  if (
    !card.metadata?.automation?.probe ||
    !worktree ||
    card.metadata.archivedAt ||
    (card.status !== "review" && card.status !== "done")
  ) {
    return undefined;
  }
  if (phase === "questions") {
    return { outcome: "needs_input", worktree };
  }
  if (phase === "grilling") {
    return { outcome: "grill", worktree };
  }
  const handoff = worktree.handoff;
  if (handoff?.phase !== "imported" || worktree.verification?.phase === "running") {
    return undefined;
  }
  // In review the round waits for its own verification when the board has a
  // verifier; a probe the operator moved to done ends without one.
  const verified = currentNodeVerification(worktree, handoff)?.phase === "done";
  return !verifier || verified || card.status === "done"
    ? { outcome: "done", worktree }
    : undefined;
}

/** The notice an ended probe is archived with. */
export function nodeProbeNotice(card: WorkboardCard, end: NodeProbeEnd): string {
  const arm = card.metadata?.automation?.probe?.arm ?? "";
  if (end.outcome !== "done") {
    return `**Probe ${arm}:** ${end.outcome}. A probe gets no answers, so it is archived with this outcome; its node worktree is removed.`;
  }
  const verification = end.worktree.verification;
  if (verification?.phase !== "done") {
    return `**Probe ${arm}:** done, not verified. Archived; it is never published.`;
  }
  return [
    `**Probe ${arm}:** done, verification ${verification.verdict}${verification.model ? ` (${verification.model})` : ""}, ${verification.findings.length} findings. Archived; it is never published.`,
    ...(verification.summary ? ["", verification.summary] : []),
  ].join("\n");
}

function probeOutcome(card: WorkboardCard): WorkboardProbeOutcome {
  const phase = nodeTicketTarget(card)?.worktree?.handoff?.phase;
  if (card.status === "blocked") {
    return "blocked";
  }
  if (phase === "questions") {
    return "needs_input";
  }
  if (phase === "grilling") {
    return "grill";
  }
  // The handoff pass archives an imported probe once its verification finished.
  return phase === "imported" && card.metadata?.archivedAt ? "done" : "running";
}

function probeRow(
  card: WorkboardCard,
  probe: WorkboardProbe,
  source: WorkboardCard | undefined,
): WorkboardProbeRow {
  const target = nodeTicketTarget(card);
  const verification = target?.worktree?.verification;
  const attempts = card.metadata?.attempts ?? [];
  const contexts = attempts.flatMap((attempt) => attempt.contextTokens ?? []);
  const outcome = probeOutcome(card);
  const firstStart = attempts[0]?.startedAt;
  const lastEnd = attempts.at(-1)?.endedAt;
  const sourceOutcome = source && workboardTicketOutcome(source);
  return {
    of: probe.of,
    ...(source ? { ofTitle: source.title } : {}),
    ...(sourceOutcome ? { source: sourceOutcome } : {}),
    arm: probe.arm,
    cardId: card.id,
    status: card.status,
    outcome,
    ...(verification?.phase === "done"
      ? {
          verification: {
            verdict: verification.verdict,
            findings: verification.findings.length,
            ...(verification.model ? { model: verification.model } : {}),
          },
        }
      : {}),
    attempts: attempts.length,
    ...(contexts.length > 0 ? { maxContextTokens: Math.max(...contexts) } : {}),
    ...(outcome !== "running" && firstStart !== undefined && lastEnd !== undefined
      ? { runTimeMs: lastEnd - firstStart }
      : {}),
    ...(target?.model ? { model: target.model } : {}),
  };
}

/**
 * Projects a board's probe cards, archived ones included, on read: one row
 * per probe beside how its source ticket fared, the rows of one source
 * together (oldest source probe first), then by arm. `of` narrows it to one
 * source card.
 */
export function projectWorkboardProbes(
  cards: readonly WorkboardCard[],
  boardId: string,
  now: number,
  of?: string,
): WorkboardProbesResult {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const probes = cards.flatMap((card) => {
    const probe = card.metadata?.automation?.probe;
    return probe && (of === undefined || probe.of === of) ? [{ card, probe }] : [];
  });
  const firstProbeOf = new Map<string, number>();
  for (const { probe } of probes) {
    firstProbeOf.set(probe.of, Math.min(firstProbeOf.get(probe.of) ?? Infinity, probe.createdAt));
  }
  return {
    boardId,
    generatedAt: now,
    probes: probes
      .toSorted(
        (left, right) =>
          (firstProbeOf.get(left.probe.of) ?? 0) - (firstProbeOf.get(right.probe.of) ?? 0) ||
          left.probe.of.localeCompare(right.probe.of) ||
          left.probe.arm.localeCompare(right.probe.arm) ||
          left.probe.createdAt - right.probe.createdAt,
      )
      .map(({ card, probe }) => probeRow(card, probe, byId.get(probe.of))),
  };
}
