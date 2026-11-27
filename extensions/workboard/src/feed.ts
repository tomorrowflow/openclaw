import type {
  WorkboardCard,
  WorkboardCommentSource,
  WorkboardNodeHandoff,
  WorkboardNodeReviewVerdict,
  WorkboardNodeVerification,
  WorkboardOrchestrationSettings,
  WorkboardPullRequestState,
  WorkboardStatus,
  WorkboardVerificationVerdict,
} from "@openclaw/workboard-contract";
import { definedFields } from "../record-fields.js";

/** One agent's finished verification as the feed last posted it. */
type FeedVerdict = {
  endedAt: number;
  verdict: WorkboardVerificationVerdict;
  summary: string;
};

/**
 * The card facts the board feed posts about, as it last posted them, so the
 * next pass posts only what changed. `commentsThrough` is the `createdAt` of
 * the newest comment it posted.
 */
export type WorkboardFeedFacts = {
  status: WorkboardStatus;
  archived?: true;
  needsUser?: true;
  nodeId?: string;
  handoff?: WorkboardNodeHandoff["phase"];
  pullRequest?: {
    url: string;
    state?: WorkboardPullRequestState;
    autoMerged?: true;
    heldPaths?: string[];
    /** The head the held-path wait was read at; the hold post's buttons name it. */
    heldAt?: string;
  };
  verification?: FeedVerdict;
  crossVerification?: FeedVerdict;
  review?: { count: number; round: number; verdict: WorkboardNodeReviewVerdict["verdict"] };
  reworkRound?: number;
  commentsThrough: number;
};

/**
 * A card's thread in its board's feed and what was last posted there.
 * `claimedCommentIds` are operator comments taken from replies in the
 * thread, which the feed does not post back.
 */
export type WorkboardCardFeed = {
  threadId?: string;
  seen: WorkboardFeedFacts;
  claimedCommentIds?: string[];
  /** When opening the thread last failed; it is tried again after a while. */
  openFailedAt?: number;
  /** The feed's agent has a session for this card, deleted when the card is archived. */
  answerSession?: true;
};

const NEEDS_USER_LABEL = "needs:user";
const SUMMARY_CHARS = 200;
const COMMENT_CHARS = 300;

type FeedEventFields = {
  opened: { status: WorkboardStatus };
  started: { nodeId?: string };
  handoff: unknown;
  verdict: {
    check: "verification" | "crossVerification";
    verdict: WorkboardVerificationVerdict;
    summary: string;
  };
  review: { round: number; verdict: WorkboardNodeReviewVerdict["verdict"] };
  pr_opened: { url: string };
  pr_held: { paths: string[]; headCommit: string };
  pr_merged: { url: string; auto: boolean };
  rework: { round: number };
  needs_user: unknown;
  blocked: unknown;
  done: unknown;
  archived: unknown;
  comment: { commentId: string; source?: WorkboardCommentSource; body: string };
};

type FeedEventKind = keyof FeedEventFields;
type FeedEventOf<K extends FeedEventKind> = { kind: K } & FeedEventFields[K];

/** One step of a card the board feed posts, in the order the diff found it. */
export type FeedEvent = { [K in FeedEventKind]: FeedEventOf<K> }[FeedEventKind];

export type FeedPersona =
  | { kind: "agent"; agentId: string }
  | { kind: "workboard" }
  | { kind: "operator" };

/** A button under a post; `value` is the callback data the press hands back. */
export type FeedButton = { label: string; value: string; style: "success" | "secondary" };

export type FeedPost = {
  text: string;
  persona: FeedPersona;
  mentionOperator: boolean;
  buttons?: FeedButton[];
};

/** What a template needs beyond its event: the card and the board's verifiers. */
export type FeedRenderContext = {
  cardId: string;
  ref: string;
  agentId?: string;
  orchestration?: Pick<WorkboardOrchestrationSettings, "verifier" | "crossVerifier">;
};

/** The interactive namespace of the hold post's buttons. */
export const HELD_MERGE_NAMESPACE = "workboard-held";

type HeldMergeAction = "approve" | "hold";

/**
 * A button's callback data: the card and the head the hold was read at.
 * It names what was pressed, never who may press it.
 */
function heldMergeCallback(action: HeldMergeAction, cardId: string, headCommit: string): string {
  return `${HELD_MERGE_NAMESPACE}:${action}:${cardId}:${headCommit}`;
}

/** Reads a press's payload, the callback data after the namespace. */
export function parseHeldMergePayload(
  payload: string,
): { action: HeldMergeAction; cardId: string; headCommit: string } | undefined {
  const [action, cardId, headCommit, ...rest] = payload.split(":");
  return (action === "approve" || action === "hold") && cardId && headCommit && !rest.length
    ? { action, cardId, headCommit }
    : undefined;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function feedVerdict(record: WorkboardNodeVerification | undefined) {
  return record?.phase === "done"
    ? {
        endedAt: record.endedAt,
        verdict: record.verdict,
        summary: oneLine(record.summary, SUMMARY_CHARS),
      }
    : undefined;
}

export function collectFeedFacts(card: WorkboardCard): WorkboardFeedFacts {
  const target = card.metadata?.automation?.target;
  const worktree = target?.worktree;
  const handoff = worktree?.handoff;
  const published = handoff?.phase === "published" ? handoff : undefined;
  const wait = published?.pullRequest?.autoMergeWait;
  const review = worktree?.reviews?.at(-1);
  const newestComment = Math.max(0, ...(card.metadata?.comments ?? []).map((c) => c.createdAt));
  return definedFields<WorkboardFeedFacts>({
    status: card.status,
    archived: card.metadata?.archivedAt ? true : undefined,
    needsUser: card.labels.includes(NEEDS_USER_LABEL) ? true : undefined,
    nodeId: target?.nodeId,
    handoff: handoff?.phase,
    pullRequest: published
      ? definedFields({
          url: published.pullRequestUrl,
          state: published.pullRequest?.state,
          autoMerged: published.pullRequest?.autoMerged,
          heldPaths: wait?.reason === "held_path" ? wait.paths : undefined,
          heldAt: wait?.reason === "held_path" ? wait.headCommit : undefined,
        })
      : undefined,
    verification: feedVerdict(worktree?.verification),
    crossVerification: feedVerdict(worktree?.crossVerification),
    review: review
      ? { count: worktree?.reviews?.length ?? 0, round: review.round, verdict: review.verdict }
      : undefined,
    reworkRound: worktree?.rework?.round,
    commentsThrough: newestComment,
  });
}

function newVerdict(prev: FeedVerdict | undefined, next: FeedVerdict | undefined) {
  return next && next.endedAt !== prev?.endedAt ? next : undefined;
}

/**
 * The steps between what the feed last posted and the card now. Fields that
 * only went away (a label removed, a verification dropped for a rerun) post
 * nothing; the feed reports progress, not every edit.
 */
export function diffFeedFacts(prev: WorkboardFeedFacts, next: WorkboardFeedFacts): FeedEvent[] {
  const events: FeedEvent[] = [];
  const entered = (status: WorkboardStatus) => next.status === status && prev.status !== status;
  if (entered("running")) {
    events.push(definedFields({ kind: "started" as const, nodeId: next.nodeId }));
  }
  if (next.handoff === "imported" && prev.handoff !== "imported") {
    events.push({ kind: "handoff" });
  }
  for (const check of ["verification", "crossVerification"] as const) {
    const verdict = newVerdict(prev[check], next[check]);
    if (verdict) {
      events.push({ kind: "verdict", check, verdict: verdict.verdict, summary: verdict.summary });
    }
  }
  if (next.review && next.review.count > (prev.review?.count ?? 0)) {
    events.push({ kind: "review", round: next.review.round, verdict: next.review.verdict });
  }
  const pr = next.pullRequest;
  if (pr && pr.url !== prev.pullRequest?.url) {
    events.push({ kind: "pr_opened", url: pr.url });
  }
  // A hold at a new head is a new hold: the buttons of the old post name the old head.
  if (pr?.heldPaths && pr.heldAt && pr.heldAt !== prev.pullRequest?.heldAt) {
    events.push({ kind: "pr_held", paths: pr.heldPaths, headCommit: pr.heldAt });
  }
  if (pr?.state === "merged" && prev.pullRequest?.state !== "merged") {
    events.push({ kind: "pr_merged", url: pr.url, auto: pr.autoMerged === true });
  }
  if ((next.reworkRound ?? 0) > (prev.reworkRound ?? 0)) {
    events.push({ kind: "rework", round: next.reworkRound ?? 0 });
  }
  if (next.needsUser && !prev.needsUser) {
    events.push({ kind: "needs_user" });
  }
  if (entered("blocked")) {
    events.push({ kind: "blocked" });
  }
  if (entered("done")) {
    events.push({ kind: "done" });
  }
  if (next.archived && !prev.archived) {
    events.push({ kind: "archived" });
  }
  return events;
}

/**
 * Card comments newer than the feed's last post, oldest first, except the
 * ones the feed itself took from replies in the thread.
 */
export function feedCommentEvents(card: WorkboardCard, feed: WorkboardCardFeed): FeedEvent[] {
  const claimed = new Set(feed.claimedCommentIds);
  return (card.metadata?.comments ?? [])
    .filter((comment) => comment.createdAt > feed.seen.commentsThrough && !claimed.has(comment.id))
    .toSorted((a, b) => a.createdAt - b.createdAt)
    .map((comment) =>
      definedFields({
        kind: "comment" as const,
        commentId: comment.id,
        source: comment.source,
        body: oneLine(comment.body, COMMENT_CHARS),
      }),
    );
}

// Webhook posts ping whatever they name, so text the feed did not write
// cannot mention anyone; the feed adds the operator's mention itself.
function quiet(text: string): string {
  return text.replace(/@(everyone|here)/gu, "@​$1").replace(/<([@#&!])/gu, "<​$1");
}

function agent(agentId: string | undefined): FeedPersona {
  return agentId ? { kind: "agent", agentId } : { kind: "workboard" };
}

const WORKBOARD: FeedPersona = { kind: "workboard" };

type Templates = {
  [K in FeedEventKind]: (event: FeedEventOf<K>, ctx: FeedRenderContext) => FeedPost;
};

function post(persona: FeedPersona, text: string, mentionOperator = false): FeedPost {
  return { persona, text, mentionOperator };
}

const TEMPLATES: Templates = {
  opened: (e, ctx) =>
    post(WORKBOARD, `${ctx.ref}: ${e.status}${ctx.agentId ? `, with @${ctx.agentId}` : ""}.`),
  started: (e, ctx) =>
    post(agent(ctx.agentId), `Started ${ctx.ref}${e.nodeId ? ` on ${quiet(e.nodeId)}` : ""}.`),
  handoff: (_e, ctx) => {
    const verifier = ctx.orchestration?.verifier?.agentId;
    return post(
      agent(ctx.agentId),
      verifier
        ? `@${verifier} ${ctx.ref} is yours: the round is ready to verify.`
        : `${ctx.ref}: the round is ready for review.`,
    );
  },
  verdict: (e, ctx) => {
    const by = ctx.orchestration?.[e.check === "verification" ? "verifier" : "crossVerifier"];
    const crossVerifier = ctx.orchestration?.crossVerifier?.agentId;
    const next =
      e.verdict !== "pass"
        ? `back to @${ctx.agentId ?? "dev"}`
        : e.check === "verification" && crossVerifier
          ? `@${crossVerifier}`
          : "review";
    return post(agent(by?.agentId), `${e.verdict}: ${quiet(e.summary)} -> ${next}`);
  },
  review: (e) => post(WORKBOARD, `Round ${e.round} review: ${e.verdict}.`),
  pr_opened: (e) => post(WORKBOARD, `PR opened: ${quiet(e.url)}`),
  pr_held: (e, ctx) => ({
    ...post(
      WORKBOARD,
      `The PR waits for the operator's merge: it touches ${quiet(e.paths.join(", "))}`,
    ),
    buttons: [
      {
        label: "Approve merge",
        value: heldMergeCallback("approve", ctx.cardId, e.headCommit),
        style: "success",
      },
      {
        label: "Keep holding",
        value: heldMergeCallback("hold", ctx.cardId, e.headCommit),
        style: "secondary",
      },
    ],
  }),
  pr_merged: (e) => post(WORKBOARD, `PR merged${e.auto ? " by Workboard" : ""}: ${quiet(e.url)}`),
  rework: (e, ctx) => post(WORKBOARD, `Rework round ${e.round} -> @${ctx.agentId ?? "dev"}`),
  needs_user: (_e, ctx) => post(WORKBOARD, `${ctx.ref} needs you.`, true),
  blocked: (_e, ctx) => post(WORKBOARD, `${ctx.ref} is blocked.`, true),
  done: (_e, ctx) => post(WORKBOARD, `${ctx.ref} is done.`),
  archived: (_e, ctx) => post(WORKBOARD, `${ctx.ref} was archived.`),
  comment: (e) =>
    post(
      e.source === "operator"
        ? { kind: "operator" }
        : agent(e.source?.slice("agent:".length) || undefined),
      quiet(e.body),
    ),
};

export function renderFeedEvent<K extends FeedEventKind>(
  event: FeedEventOf<K>,
  ctx: FeedRenderContext,
): FeedPost {
  return TEMPLATES[event.kind](event, ctx);
}

const TITLE_KEY = /^\[([^\]\s]{1,32})\]/u;

/** The card's own key from a `[KEY] title`, else a short id. */
export function feedCardRef(card: Pick<WorkboardCard, "id" | "title">): string {
  const key = TITLE_KEY.exec(card.title)?.[1];
  return key ? quiet(key) : card.id.slice(0, 8);
}

/** Discord caps thread names at 100 characters. */
export function feedThreadName(card: Pick<WorkboardCard, "id" | "title">): string {
  const name = TITLE_KEY.test(card.title) ? card.title : `[${feedCardRef(card)}] ${card.title}`;
  return oneLine(name, 100);
}
