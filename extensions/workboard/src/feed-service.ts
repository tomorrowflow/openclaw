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
import type { OpenClawPluginService } from "../api.js";
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

type FeedStore = Pick<
  WorkboardStore,
  "ready" | "runOperation" | "subscribeChanges" | "list" | "listBoards" | "addComment"
>;

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
export function createWorkboardFeedService(params: {
  store: FeedStore;
  /** Opens the store of each card's thread and last posted facts, keyed by card id. */
  openState: () => Pick<PluginStateKeyedStore<WorkboardCardFeed, 2>, "entries" | "register">;
  channel: Pick<PluginRuntime["channel"], "outbound" | "bindings">;
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
    const cfg = params.config();
    const rendered = renderFeedEvent(event, {
      ref: feedCardRef(card),
      agentId: card.agentId,
      orchestration: board.orchestration,
    });
    const mention = rendered.mentionOperator && feed.operatorId ? `<@${feed.operatorId}> ` : "";
    const attempt = async () => {
      const adapter = await channel.outbound.loadAdapter(feed.channel);
      if (!adapter?.sendText) {
        throw new Error(`Channel ${feed.channel} has no text sender for the Workboard feed.`);
      }
      await adapter.sendText({
        cfg,
        to: feed.to,
        text: `${mention}${rendered.text}`,
        threadId,
        ...(feed.accountId ? { accountId: feed.accountId } : {}),
        identity: identity(cfg, rendered.persona),
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

  const syncCard = async (
    feeds: ReadonlyMap<string, WorkboardCardFeed>,
    card: WorkboardCard,
    board: FeedBoard,
  ) => {
    const next = collectFeedFacts(card);
    const active = !next.archived && next.status !== "done";
    const state = feeds.get(card.id);
    // No backfill: a card the feed has not seen gets one opening line once it
    // is active, and its later steps from then on.
    if (!state?.threadId) {
      if (!active || (state && diffFeedFacts(state.seen, next).length === 0)) {
        return;
      }
      const threadId = await openThread(card, board);
      if (threadId) {
        await send(board.feed, threadId, { kind: "opened", status: next.status }, card, board);
      }
      await record(card.id, { ...(threadId ? { threadId } : {}), seen: next });
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
    const recorded: WorkboardCardFeed = { threadId: state.threadId, seen: next };
    await record(card.id, recorded);
  };

  const pass = async () => {
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
      const scheduler = ctx.scheduler;
      if (!scheduler || unsubscribe) {
        return;
      }
      await store.ready();
      let job: { cancel: () => void } | undefined;
      const schedule = () => {
        job = scheduler.schedule({
          id: "workboard-feed",
          delayMs: FEED_DEBOUNCE_MS,
          mode: "earliest",
          run: () =>
            sync().catch((error: unknown) => {
              ctx.logger.warn(`workboard feed pass failed: ${formatErrorMessage(error)}`);
            }),
        });
      };
      const subscription = store.subscribeChanges(schedule);
      unsubscribe = () => {
        subscription();
        job?.cancel();
      };
      schedule();
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
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
      const operatorId = board?.orchestration?.feed?.operatorId;
      // Threads stay bound after a board's feed is turned off, and an
      // unhandled message in a bound thread gets no normal routing.
      if (!operatorId) {
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
      });
      // Replies from anyone else stay in the thread; the card is the record.
      return { handled: true };
    },
  };
}
