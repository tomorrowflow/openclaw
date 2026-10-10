import type {
  WorkboardBoardMetadata,
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardChange,
  WorkboardListResult,
  WorkboardMetadata,
  WorkboardSessionPlacement,
  WorkboardSessionsBoard,
  WorkboardSessionsBoardSpec,
  WorkboardStatus,
  WorkboardTrustResult,
} from "@openclaw/workboard-contract";
import { WORKBOARD_STATUSES } from "@openclaw/workboard-contract";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { redactClaimToken } from "./card-redaction.js";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardSessionPlacementWrite,
  WorkboardSessionsBoardStore,
  WorkboardSubscriptionStore,
  WorkboardWriteAuthority,
} from "./persistence-types.js";
import { normalizeBoardMetadata } from "./store-board-normalizers.js";
import type {
  WorkboardBoardInput,
  WorkboardLinkedCreateInput,
  WorkboardListOptions,
  WorkboardStatsResult,
} from "./store-inputs.js";
import {
  normalizeBoardId,
  normalizeBoardIdRequired,
  normalizeLabels,
} from "./store-normalizers.js";
import { freezeCardList, readCards } from "./store-read.js";
import { WorkboardStoreRuntime } from "./store-runtime.js";
import type { WorkboardTargetModelCheck } from "./target-model-policy.js";
import { projectWorkboardTrust } from "./trust-kpis.js";

export class WorkboardBoardStore extends WorkboardStoreRuntime {
  protected readonly store: WorkboardCardStore;
  protected readonly boardStore: WorkboardKeyedStore<PersistedWorkboardBoard>;
  protected readonly subscriptionStore: WorkboardSubscriptionStore;
  protected readonly attachmentStore: WorkboardKeyedStore<PersistedWorkboardAttachment>;
  private readonly sessionsBoardStore: WorkboardSessionsBoardStore;
  /** Installed by the plugin entry; tests without model policy leave it unset. */
  checkTargetModel?: WorkboardTargetModelCheck;

  constructor(
    store: WorkboardCardStore,
    stores: {
      boards: WorkboardKeyedStore<PersistedWorkboardBoard>;
      sessionsBoard: WorkboardSessionsBoardStore;
      subscriptions: WorkboardSubscriptionStore;
      attachments: WorkboardKeyedStore<PersistedWorkboardAttachment>;
      ready?: Promise<number>;
      dataVersion?: () => number | Promise<number>;
      close?: () => void | Promise<void>;
      runWithWriteAuthority?: WorkboardWriteAuthority;
    },
  ) {
    super(stores.dataVersion, stores.close, stores.ready, stores.runWithWriteAuthority);
    this.store = this.trackCardStore(store);
    this.boardStore = this.track(stores.boards, { sessions: true });
    this.sessionsBoardStore = stores.sessionsBoard;
    this.subscriptionStore = {
      ...this.track(stores.subscriptions, { notifyChanges: false }),
      entries: (options) => this.runOperation(() => stores.subscriptions.entries(options)),
    };
    this.attachmentStore = {
      ...this.track(stores.attachments, { notifyChanges: false }),
      // Deletion also removes the card's metadata row, unlike blob-only registration.
      delete: (key) => this.trackMutation(() => stores.attachments.delete(key)),
    };
  }

  async list(options: WorkboardListOptions = {}): Promise<WorkboardCard[]> {
    const boardId = normalizeBoardId(options.boardId);
    return readCards(this.store, boardId === undefined ? undefined : { kind: "board", boardId });
  }

  listCards(board: unknown): Promise<
    WorkboardListResult & {
      boards: WorkboardBoardSummary[];
      revision: WorkboardChange & { boardId?: string };
    }
  > {
    return this.runOperation(() => {
      const boardId = normalizeBoardId(board);
      const cached = this.cardLists.get(boardId);
      if (cached) {
        return cached;
      }
      const pending = Promise.all([this.list({ boardId }), this.listBoards()])
        .then(([cards, { boards }]) => {
          // A write or external-change publication during the read retires this
          // snapshot; readers join the replacement instead of publishing stale data.
          if (this.cardLists.get(boardId) !== pending) {
            return this.listCards(boardId);
          }
          const result = {
            cards: cards.map(redactClaimToken),
            boards,
            statuses: WORKBOARD_STATUSES,
            revision: { ...this.cardsRevision, ...(boardId === undefined ? {} : { boardId }) },
          };
          freezeCardList(result);
          // Arbitrary missing-board queries must not grow the retained cache.
          if (boardId !== undefined && !boards.some((entry) => entry.id === boardId)) {
            this.cardLists.delete(boardId);
          }
          return result;
        })
        .catch((error: unknown) => {
          if (this.cardLists.get(boardId) === pending) {
            this.cardLists.delete(boardId);
          }
          throw error;
        });
      this.cardLists.set(boardId, pending);
      return pending;
    });
  }

  async listBoards(): Promise<{ boards: WorkboardBoardSummary[] }> {
    const boards = new Map<string, WorkboardBoardSummary>();
    for (const entry of await this.boardStore.entries()) {
      if (entry.value?.version !== 1 || !entry.value.board?.id) {
        continue;
      }
      const board = entry.value.board;
      boards.set(board.id, {
        id: board.id,
        ...(board.kind ? { kind: board.kind } : {}),
        ...(board.kind === "sessions" ? { sessions: board.sessions } : {}),
        ...(board.name ? { name: board.name } : {}),
        ...(board.description ? { description: board.description } : {}),
        ...(board.icon ? { icon: board.icon } : {}),
        ...(board.color ? { color: board.color } : {}),
        ...(board.automationJobId ? { automationJobId: board.automationJobId } : {}),
        ...(board.defaultWorkspace ? { defaultWorkspace: board.defaultWorkspace } : {}),
        ...(board.orchestration ? { orchestration: board.orchestration } : {}),
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        updatedAt: board.updatedAt,
        ...(board.archivedAt ? { archivedAt: board.archivedAt } : {}),
      });
    }
    if (!boards.has("default")) {
      boards.set("default", {
        id: "default",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
      });
    }
    const cardAggregates = await this.store.listBoardAggregates();
    for (const aggregate of cardAggregates) {
      const boardId = aggregate.boardId;
      const summary =
        boards.get(boardId) ??
        ({
          id: boardId,
          total: 0,
          active: 0,
          archived: 0,
          byStatus: {},
        } satisfies WorkboardBoardSummary);
      summary.total += aggregate.total;
      summary.archived += aggregate.archived;
      summary.active += aggregate.total - aggregate.archived;
      summary.byStatus[aggregate.status] =
        (summary.byStatus[aggregate.status] ?? 0) + aggregate.total;
      summary.updatedAt = Math.max(summary.updatedAt ?? 0, aggregate.updatedAt);
      boards.set(boardId, summary);
    }
    return {
      boards: [...boards.values()].toSorted((a, b) =>
        a.id === "default" ? -1 : b.id === "default" ? 1 : a.id.localeCompare(b.id),
      ),
    };
  }

  async stats(input: WorkboardListOptions = {}, now = Date.now()): Promise<WorkboardStatsResult> {
    const boardId = normalizeBoardId(input.boardId);
    const aggregates = await this.store.listStatsAggregates(boardId);
    const byStatus: Partial<Record<WorkboardStatus, number>> = {};
    const byAgent: Record<string, number> = Object.create(null);
    let oldestReadyAt: number | undefined;
    let updatedAt: number | undefined;
    let archived = 0;
    let total = 0;
    for (const aggregate of aggregates) {
      byStatus[aggregate.status] = (byStatus[aggregate.status] ?? 0) + aggregate.total;
      const agentId = aggregate.agentId ?? "(default)";
      byAgent[agentId] = (byAgent[agentId] ?? 0) + aggregate.total;
      total += aggregate.total;
      archived += aggregate.archived;
      if (aggregate.oldestReadyAt !== undefined) {
        oldestReadyAt = Math.min(oldestReadyAt ?? aggregate.oldestReadyAt, aggregate.oldestReadyAt);
      }
      updatedAt = Math.max(updatedAt ?? 0, aggregate.updatedAt);
    }
    return {
      id: boardId ?? "all",
      total,
      active: total - archived,
      archived,
      byStatus,
      byAgent,
      ...(oldestReadyAt ? { oldestReadyAgeMs: Math.max(0, now - oldestReadyAt) } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  async trust(input: WorkboardListOptions = {}, now = Date.now()): Promise<WorkboardTrustResult> {
    const boardId = normalizeBoardId(input.boardId);
    return projectWorkboardTrust(await this.list({ boardId }), boardId ?? "all", now);
  }

  /**
   * New work on a board inherits its assignee and, on a project board, the
   * node target of its first matching label route or else the board default;
   * explicit choices and linked sessions keep theirs.
   */
  protected async withBoardDefaults(
    metadata: WorkboardMetadata,
    input: WorkboardLinkedCreateInput,
    sessionKey: string | undefined,
  ): Promise<{ metadata: WorkboardMetadata; agentId?: string }> {
    const requestedAgentId = normalizeOptionalString(input.agentId);
    if (sessionKey) {
      return { metadata, agentId: requestedAgentId };
    }
    const automation = metadata.automation;
    const orchestration = (await this.boardStore.lookup(automation?.boardId ?? "default"))?.board
      .orchestration;
    const agentId = requestedAgentId ?? orchestration?.defaultAssignee;
    const requestedAutomation = isRecord(input.metadata) ? input.metadata.automation : undefined;
    const workspace = automation?.workspace;
    const labels = normalizeLabels(input.labels);
    const target =
      (isRecord(requestedAutomation) && Object.hasOwn(requestedAutomation, "target")) ||
      (workspace && workspace.kind !== "scratch")
        ? undefined
        : (orchestration?.targetRoutes?.find((route) =>
            route.labels.some((label) => labels.includes(label)),
          )?.target ?? orchestration?.defaultTarget);
    return {
      metadata: target ? { ...metadata, automation: { ...automation, target } } : metadata,
      ...(agentId ? { agentId } : {}),
    };
  }

  async upsertBoard(input: WorkboardBoardInput): Promise<WorkboardBoardMetadata> {
    return await this.enqueueMutation(async () => {
      const id = normalizeBoardIdRequired(input.id);
      const existing = await this.boardStore.lookup(id);
      const board = normalizeBoardMetadata({ ...input, id }, existing?.board);
      this.assertTargetModelAllowed(input, board);
      await this.boardStore.register(id, { version: 1, board });
      return board.kind === "sessions" ? await this.getSessionsBoard(id) : board;
    });
  }

  /**
   * Checks only writes that set the target or the assignee, so a board saved
   * before its agent's policy changed can still be renamed or archived;
   * dispatch still meets core's refusal for those.
   */
  private assertTargetModelAllowed(input: WorkboardBoardInput, board: WorkboardBoardMetadata) {
    const requested = isRecord(input.orchestration) ? input.orchestration : {};
    const orchestration = board.orchestration;
    if (!this.checkTargetModel || !orchestration) {
      return;
    }
    const assigneeChanged = Object.hasOwn(requested, "defaultAssignee");
    const targets = [
      ...(assigneeChanged || Object.hasOwn(requested, "defaultTarget")
        ? [{ kind: "default", model: orchestration.defaultTarget?.model }]
        : []),
      ...(assigneeChanged || Object.hasOwn(requested, "targetRoutes")
        ? (orchestration.targetRoutes ?? []).map((route) => ({
            kind: "route",
            model: route.target.model,
          }))
        : []),
    ];
    const agentId = orchestration.defaultAssignee;
    for (const { kind, model } of targets) {
      const refusal = model ? this.checkTargetModel({ agentId, model }) : undefined;
      if (refusal) {
        throw new Error(
          `Board ${board.id} ${kind} target model ${model} is not allowed for ${agentId ? `agent ${agentId}` : "the default agent"} (${refusal}). Add it to that agent's modelPolicy.allow or choose an allowed model.`,
        );
      }
    }
  }

  getSessionsBoard(boardId: string): Promise<WorkboardSessionsBoard> {
    return this.runOperation(() => this.sessionsBoardStore.get(normalizeBoardIdRequired(boardId)));
  }

  updateSessionsBoard(
    boardId: string,
    patch: unknown,
    assertCurrent?: () => void,
  ): Promise<WorkboardSessionsBoard> {
    return this.enqueueMutation(
      () =>
        this.trackMutation(
          () => this.sessionsBoardStore.update(normalizeBoardIdRequired(boardId), patch),
          () => true,
          true,
        ),
      assertCurrent,
    );
  }

  listSessionPlacements(boardId: string): Promise<WorkboardSessionPlacement[]> {
    return this.runOperation(() =>
      this.sessionsBoardStore.listPlacements(normalizeBoardIdRequired(boardId)),
    );
  }

  repairSessionPlacements(): Promise<{ placements: number; boards: number }> {
    return this.enqueueMutation(() =>
      this.trackMutation(
        () => this.sessionsBoardStore.repairPlacements(),
        (result) => result.placements > 0 || result.boards > 0,
        true,
      ),
    );
  }

  writeSessionPlacement(
    boardId: string,
    placement: WorkboardSessionPlacementWrite,
    options: { expectedSpec: WorkboardSessionsBoardSpec; assertCurrent?: () => void },
  ): Promise<boolean> {
    return this.enqueueMutation(
      () =>
        this.trackMutation(
          () =>
            this.sessionsBoardStore.writePlacement(
              normalizeBoardIdRequired(boardId),
              placement,
              options.expectedSpec,
            ),
          Boolean,
          true,
        ),
      options.assertCurrent,
    );
  }

  async assertCardsBoard(boardId: string): Promise<void> {
    if (
      (await this.boardStore.lookup(normalizeBoardIdRequired(boardId)))?.board.kind === "sessions"
    ) {
      throw new Error("Sessions boards do not hold cards");
    }
  }

  async archiveBoard(id: unknown, archived: unknown = true): Promise<WorkboardBoardMetadata> {
    return await this.upsertBoard({ id, archived });
  }

  async deleteBoard(id: unknown): Promise<{ deleted: boolean }> {
    return await this.enqueueMutation(async () => {
      const boardId = normalizeBoardIdRequired(id);
      if (boardId === "default") {
        throw new Error("default board cannot be deleted.");
      }
      if (await this.store.hasCards(boardId)) {
        throw new Error("board still has cards; archive it or move/delete the cards first.");
      }
      for (const entry of await this.subscriptionStore.entries({ boardId })) {
        if (entry.value?.version === 1 && entry.value.subscription?.boardId === boardId) {
          await this.subscriptionStore.delete(entry.key);
        }
      }
      return { deleted: await this.boardStore.delete(boardId) };
    });
  }
}
