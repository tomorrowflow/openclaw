import type {
  WorkboardBoardFeed,
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardHealthFeed,
} from "@openclaw/workboard-contract";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveFirstBoundAccountId } from "openclaw/plugin-sdk/routing";
import type { OpenClawPluginService } from "../api.js";
import {
  buildFeedAnswerMessage,
  FEED_ANSWER_TIMEOUT_MS,
  feedAnswerSessionKey,
  finalAssistantText,
  unansweredOperatorComments,
} from "./feed-answer.js";
import {
  collectFeedFacts,
  diffFeedFacts,
  feedCardRef,
  feedCommentEvents,
  feedThreadName,
  renderFeedEvent,
  type FeedEvent,
  type FeedPersona,
  type WorkboardCardFeed,
} from "./feed.js";
import { cardBoardId } from "./store-card-helpers.js";
import type { WorkboardStore } from "./store.js";

const FEED_DEBOUNCE_MS = 2_000;
// A thread that failed to open is tried again on a pass after this long.
const FEED_OPEN_RETRY_MS = 10 * 60_000;

type FeedStore = Pick<
  WorkboardStore,
  "ready" | "runOperation" | "subscribeChanges" | "list" | "listBoards" | "addComment" | "get"
>;

type Scheduler = NonNullable<Parameters<OpenClawPluginService["start"]>[0]["scheduler"]>;

type FeedBoard = Pick<WorkboardBoardSummary, "id" | "orchestration"> & {
  feed: WorkboardBoardFeed;
};

export type WorkboardFeedService = OpenClawPluginService & {
  stop: () => Promise<void>;
  /** One pass over every card on a board with a feed; serialized with claims. */
  sync: () => Promise<void>;
  claim: (
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ) => Promise<PluginHookInboundClaimResult | undefined>;
  health: () => WorkboardHealthFeed | undefined;
};

/**
 * Projects card steps into each feed board's chat channel, one thread per
 * card, and takes the operator's replies there as card comments. Best
 * effort: a post gets one retry, then counts as a failure and the snapshot
 * moves on, so nothing is replayed.
 */
/** Settles with `work`, or rejects once `signal` aborts so a stop never waits on it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createWorkboardFeedService(params: {
  store: FeedStore;
  /** Opens the store of each card's thread and last posted facts, keyed by card id. */
  openState: () => Pick<PluginStateKeyedStore<WorkboardCardFeed, 2>, "entries" | "register">;
  channel: Pick<PluginRuntime["channel"], "outbound" | "bindings">;
  /** Runs the board's `feed.agentId` on the operator's thread replies. */
  subagent?: Pick<
    PluginRuntime["subagent"],
    "run" | "waitForRun" | "getSessionMessages" | "deleteSession"
  >;
  config: () => OpenClawConfig;
  /** The nudge an operator comment from the Control UI gets. */
  onOperatorComment?: (input: { cards: readonly WorkboardCard[] }) => Promise<void>;
  now?: () => number;
}): WorkboardFeedService {
  const { store, channel } = params;
  const now = params.now ?? Date.now;
  let unsubscribe: (() => void) | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let health: WorkboardHealthFeed | undefined;
  // Set by a pass that left a card waiting to retry its thread open, so the
  // retry runs on a timer and not only on the next card change.
  let openRetryPending = false;
  let scheduler: Scheduler | undefined;
  // Cards with an answer turn in flight; `again` asks for one more turn after
  // it, and `throughId` is the last operator comment a turn already included.
  const answering = new Map<string, { again: boolean; throughId?: string }>();

  // Passes and claims share one queue, so a claim's comment and its
  // claimedCommentIds land before the next pass reads the card.
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(
      () => store.runOperation(run),
      () => store.runOperation(run),
    );
    tail = result.catch(() => undefined);
    return result;
  };

  let openedStore: ReturnType<typeof params.openState> | undefined;
  const feedStore = () => (openedStore ??= params.openState());
  // The service is the only writer of its namespace, so the map loaded once
  // stays current through `record`.
  let loadedFeeds: Promise<Map<string, WorkboardCardFeed>> | undefined;
  const loadFeeds = () => {
    loadedFeeds ??= feedStore()
      .entries()
      .then(
        (entries) => new Map(entries.map((entry) => [entry.key, entry.value])),
        (error: unknown) => {
          loadedFeeds = undefined;
          throw error;
        },
      );
    return loadedFeeds;
  };
  const record = async (cardId: string, feed: WorkboardCardFeed) => {
    (await loadFeeds()).set(cardId, feed);
    await feedStore().register(cardId, feed);
  };

  const counted = (error?: unknown) => {
    const at = now();
    health = health ?? { posts: 0, failures: 0 };
    if (error === undefined) {
      health = { ...health, posts: health.posts + 1, lastPostAt: at };
    } else {
      health = {
        ...health,
        failures: health.failures + 1,
        lastFailureAt: at,
        lastError: formatErrorMessage(error),
      };
    }
  };

  const conversation = (feed: WorkboardBoardFeed) => ({
    channel: feed.channel,
    accountId: feed.accountId ?? "default",
    conversationId: feed.to,
  });

  const bindingData = (card: WorkboardCard, board: FeedBoard) => ({
    cardId: card.id,
    boardId: board.id,
  });

  const identity = (cfg: OpenClawConfig, persona: FeedPersona) => {
    if (persona.kind !== "agent") {
      return { name: persona.kind === "operator" ? "operator" : "Workboard" };
    }
    const resolved = resolveAgentOutboundIdentity(cfg, persona.agentId);
    const name = resolved?.name ?? persona.agentId;
    return { ...resolved, name: resolved?.emoji ? `${resolved.emoji} ${name}` : name };
  };

  const send = async (
    feed: WorkboardBoardFeed,
    threadId: string,
    event: FeedEvent,
    card: WorkboardCard,
    board: FeedBoard,
  ) => {
    const rendered = renderFeedEvent(event, {
      ref: feedCardRef(card),
      agentId: card.agentId,
      orchestration: board.orchestration,
    });
    const mention = rendered.mentionOperator && feed.operatorId ? `<@${feed.operatorId}> ` : "";
    await postText(feed, threadId, `${mention}${rendered.text}`, rendered.persona);
  };

  const postText = async (
    feed: WorkboardBoardFeed,
    threadId: string,
    text: string,
    persona: FeedPersona,
  ) => {
    const cfg = params.config();
    const attempt = async () => {
      const adapter = await channel.outbound.loadAdapter(feed.channel);
      if (!adapter?.sendText) {
        throw new Error(`Channel ${feed.channel} has no text sender for the Workboard feed.`);
      }
      await adapter.sendText({
        cfg,
        to: feed.to,
        text,
        threadId,
        ...(feed.accountId ? { accountId: feed.accountId } : {}),
        identity: identity(cfg, persona),
      });
    };
    try {
      await attempt().catch(attempt);
      counted();
    } catch (error) {
      counted(error);
    }
  };

  const openThread = async (card: WorkboardCard, board: FeedBoard) => {
    try {
      const binding = await channel.bindings.bindOwned({
        conversation: conversation(board.feed),
        threadName: feedThreadName(card),
        data: bindingData(card, board),
        idleTimeoutMs: 0,
      });
      return binding.conversationId;
    } catch (error) {
      counted(error);
      return undefined;
    }
  };

  /**
   * One turn of the feed's agent on the card's unanswered operator messages.
   * Workboard records the turn's final reply as the agent's comment, so the
   * answer lands even on a card another agent has claimed for its round.
   */
  const answerOnce = async (
    cardId: string,
    feed: WorkboardBoardFeed,
    agentId: string,
    turn: { throughId?: string },
  ) => {
    const card = await store.get(cardId);
    const threadId = (await loadFeeds()).get(cardId)?.threadId;
    const unanswered = card ? unansweredOperatorComments(card, agentId, turn.throughId) : [];
    const latest = unanswered.at(-1);
    if (!card || !threadId || !latest || !scheduler || !params.subagent) {
      return;
    }
    turn.throughId = latest.id;
    const { subagent } = params;
    const lifetime = scheduler.signal;
    const sessionKey = feedAnswerSessionKey(agentId, cardId);
    const typing = new AbortController();
    const cfg = params.config();
    const keepTyping = (accountId: string | undefined) =>
      channel.outbound.keepTyping({
        cfg,
        channel: feed.channel,
        to: feed.to,
        ...(accountId ? { accountId } : {}),
        threadId,
        signal: AbortSignal.any([typing.signal, lifetime]),
      });
    // The agent's own bot types when one is bound to it on this channel, since
    // a webhook persona cannot; the feed's bot types when that one cannot see
    // the thread. The indicator is decoration: the answer or the failure line
    // still follows.
    const agentAccountId = resolveFirstBoundAccountId({ cfg, channelId: feed.channel, agentId });
    const typed = (
      agentAccountId && agentAccountId !== feed.accountId
        ? keepTyping(agentAccountId).catch(() => keepTyping(feed.accountId))
        : keepTyping(feed.accountId)
    ).catch(() => undefined);
    try {
      const run = await subagent.run({
        assertCurrent: () => lifetime.throwIfAborted(),
        sessionKey,
        message: buildFeedAnswerMessage({ card, boardId: cardBoardId(card), unanswered }),
        lane: `workboard-thread:${cardId}`,
        idempotencyKey: `workboard-feed-answer:${cardId}:${latest.id}`,
        deliver: false,
      });
      await serialize(async () => {
        const feedState = (await loadFeeds()).get(cardId);
        if (feedState && !feedState.answerSession) {
          await record(cardId, { ...feedState, answerSession: true });
        }
      });
      // A run that outlasts the wait keeps going on the card's lane; its late
      // reply is dropped and the next turn queues behind it. Accepted: the
      // failure line already told the operator, and their comment is saved.
      const wait = await untilAborted(
        subagent.waitForRun({ runId: run.runId, timeoutMs: FEED_ANSWER_TIMEOUT_MS }),
        lifetime,
      );
      if (wait.status !== "ok") {
        throw new Error(
          wait.status === "timeout" ? "no answer within 5 minutes" : (wait.error ?? wait.status),
        );
      }
      const answer = finalAssistantText(
        (await subagent.getSessionMessages({ sessionKey, limit: 5 })).messages,
      );
      if (!answer) {
        throw new Error("the turn ended without an answer");
      }
      await store.addComment(cardId, { body: answer }, undefined, `agent:${agentId}`);
    } catch (error) {
      if (lifetime.aborted) {
        return;
      }
      counted(error);
      const name = identity(params.config(), { kind: "agent", agentId }).name;
      await postText(
        feed,
        threadId,
        `${name} couldn't answer (${formatErrorMessage(error)}). Your comment is saved on the card.`,
        { kind: "workboard" },
      );
    } finally {
      typing.abort();
      await typed;
    }
  };

  // One turn per card at a time; replies that arrive meanwhile are answered
  // together by the next turn, which reads every unanswered operator comment.
  const requestAnswer = (cardId: string, feed: WorkboardBoardFeed) => {
    const agentId = feed.agentId;
    const turn = answering.get(cardId);
    if (!agentId || !scheduler || !params.subagent) {
      return;
    }
    if (turn) {
      turn.again = true;
      return;
    }
    const state: { again: boolean; throughId?: string } = { again: false };
    answering.set(cardId, state);
    scheduler.schedule({
      id: `workboard-feed-answer:${cardId}`,
      delayMs: 0,
      run: async () => {
        try {
          do {
            state.again = false;
            await answerOnce(cardId, feed, agentId, state);
          } while (state.again && !scheduler?.signal.aborted);
        } finally {
          answering.delete(cardId);
        }
      },
    });
  };

  const syncCard = async (
    feeds: ReadonlyMap<string, WorkboardCardFeed>,
    card: WorkboardCard,
    board: FeedBoard,
  ) => {
    const next = collectFeedFacts(card);
    const active = !next.archived && next.status !== "done";
    let state = feeds.get(card.id);
    const agentId = board.feed.agentId;
    if (next.archived && state?.answerSession && agentId && params.subagent) {
      // Best effort: a session that outlives its card is only an idle transcript.
      await params.subagent
        .deleteSession({ sessionKey: feedAnswerSessionKey(agentId, card.id) })
        .catch(() => undefined);
      const { answerSession: _deleted, ...rest } = state;
      state = rest;
      await record(card.id, state);
    }
    // No backfill: a card the feed has not seen gets one opening line once it
    // is active, and its later steps from then on.
    if (!state?.threadId) {
      const retryDue = now() - (state?.openFailedAt ?? 0) >= FEED_OPEN_RETRY_MS;
      if (!active) {
        return;
      }
      if (state && !retryDue && diffFeedFacts(state.seen, next).length === 0) {
        openRetryPending = true;
        return;
      }
      const threadId = await openThread(card, board);
      if (threadId) {
        await send(board.feed, threadId, { kind: "opened", status: next.status }, card, board);
      }
      await record(
        card.id,
        threadId ? { threadId, seen: next } : { seen: next, openFailedAt: now() },
      );
      openRetryPending ||= !threadId;
      return;
    }
    const events = [...diffFeedFacts(state.seen, next), ...feedCommentEvents(card, state)];
    if (events.length > 0) {
      for (const event of events) {
        await send(board.feed, state.threadId, event, card, board);
      }
    }
    if (JSON.stringify(state.seen) === JSON.stringify(next) && !state.claimedCommentIds?.length) {
      return;
    }
    // A crash between the posts above and this write posts them again on the
    // next pass; accepted for a best-effort projection.
    const recorded: WorkboardCardFeed = {
      threadId: state.threadId,
      seen: next,
      ...(state.answerSession ? { answerSession: true } : {}),
    };
    await record(card.id, recorded);
  };

  const pass = async () => {
    openRetryPending = false;
    const boards = new Map<string, FeedBoard>();
    for (const board of (await store.listBoards()).boards) {
      const feed = board.orchestration?.feed;
      if (feed && !board.archivedAt) {
        boards.set(board.id, {
          id: board.id,
          orchestration: board.orchestration,
          feed,
        });
      }
    }
    if (boards.size === 0) {
      return;
    }
    const feeds = await loadFeeds();
    for (const card of await store.list()) {
      const board = boards.get(cardBoardId(card));
      if (board) {
        await syncCard(feeds, card, board);
      }
    }
  };

  const sync = () => serialize(pass);

  return {
    id: "workboard-feed",
    async start(ctx) {
      if (!ctx.scheduler || unsubscribe) {
        return;
      }
      const serviceScheduler = ctx.scheduler;
      scheduler = serviceScheduler;
      await store.ready();
      const jobs = new Map<string, { cancel: () => void }>();
      const schedule = (id = "workboard-feed", delayMs = FEED_DEBOUNCE_MS) => {
        jobs.set(
          id,
          serviceScheduler.schedule({
            id,
            delayMs,
            mode: "earliest",
            run: () =>
              sync().then(
                () => {
                  if (openRetryPending) {
                    schedule("workboard-feed-retry", FEED_OPEN_RETRY_MS);
                  }
                },
                (error: unknown) => {
                  ctx.logger.warn(`workboard feed pass failed: ${formatErrorMessage(error)}`);
                },
              ),
          }),
        );
      };
      const subscription = store.subscribeChanges(() => schedule());
      unsubscribe = () => {
        subscription();
        for (const job of jobs.values()) {
          job.cancel();
        }
      };
      schedule();
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      scheduler = undefined;
      await tail;
    },
    sync,
    health: () => health,
    async claim(event, ctx) {
      const data = ctx.pluginBinding?.data;
      const cardId = data?.cardId;
      const boardId = data?.boardId;
      if (typeof cardId !== "string" || typeof boardId !== "string") {
        return undefined;
      }
      const board = (await store.listBoards()).boards.find((entry) => entry.id === boardId);
      const boardFeed = board?.orchestration?.feed;
      const operatorId = boardFeed?.operatorId;
      // Threads stay bound after a board's feed is turned off, and an
      // unhandled message in a bound thread gets no normal routing.
      if (!boardFeed || !operatorId) {
        return {
          handled: true,
          reply: {
            text: "This board's Workboard feed takes no replies right now. Comment on the card in the Control UI instead.",
          },
        };
      }
      // Waits behind a running feed pass so the claimed id lands before the
      // next pass reads the card; a pass is short except when a feed is first
      // turned on for a board with many active cards.
      await serialize(async () => {
        if (event.senderId !== operatorId || !event.content.trim()) {
          return;
        }
        const card = await store.addComment(cardId, { body: event.content }, undefined, "operator");
        const comment = card.metadata?.comments?.at(-1);
        const feed = (await loadFeeds()).get(cardId);
        if (feed && comment) {
          await record(cardId, {
            ...feed,
            claimedCommentIds: [...(feed.claimedCommentIds ?? []), comment.id],
          });
        }
        await params.onOperatorComment?.({ cards: [card] });
        requestAnswer(cardId, boardFeed);
      });
      // Replies from anyone else stay in the thread; the card is the record.
      return { handled: true };
    },
  };
}
