import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  WorkboardArtifact,
  WorkboardCard,
  WorkboardClaim,
  WorkboardMetadata,
  WorkboardNotification,
  WorkboardRunAttempt,
} from "@openclaw/workboard-contract";
import {
  isFutureDateTimestampMs,
  resolveOptionalIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  appendComment,
  assertCanMutateClaimedCard,
  cardBoardId,
  cardChildIds,
  cardParentIds,
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
  retryBudgetExhausted,
} from "./store-card-helpers.js";
import {
  addWorkboardDurationMs,
  DEFAULT_CLAIM_TTL_MS,
  DEFAULT_NODE_TICKET_CONCURRENCY,
  isWorkboardClaimReclaimable,
  isWorkboardNodeTicket,
  type WorkboardClaimSlot,
  workboardSlotBusyMessage,
  MAX_CARD_ARTIFACTS,
  MAX_CARD_COMMENTS,
  MAX_BLOCK_REASON_CHARS,
  MAX_CARD_NOTIFICATIONS,
  secondsToDurationMs,
} from "./store-constants.js";
import type {
  WorkboardBlockInput,
  WorkboardCardPatch,
  WorkboardClaimInput,
  WorkboardClaimOptions,
  WorkboardCompleteInput,
  WorkboardDecomposeInput,
  WorkboardHeartbeatInput,
  WorkboardMutationScope,
  WorkboardReassignInput,
  WorkboardReclaimInput,
  WorkboardSpecifyInput,
} from "./store-inputs.js";
import {
  appendCompletionProof,
  capText,
  clearDiagnostics,
  deriveChildIdempotencyKey,
  normalizeArtifact,
  normalizeAutomation,
  normalizeProofInput,
  normalizeStatus,
  normalizeStringList,
} from "./store-normalizers.js";
import { WorkboardPromoteStore } from "./store-promote.js";
import { normalizeBoundedString } from "./store-value-normalizers.js";

function assertClaimIdentity(claim: WorkboardClaim, input: WorkboardHeartbeatInput): void {
  const token = normalizeOptionalString(input.token);
  const ownerId = normalizeOptionalString(input.ownerId);
  if (token && !safeEqualSecret(token, claim.token)) {
    throw new Error("claim token does not match.");
  }
  if (!token && ownerId && ownerId !== claim.ownerId) {
    throw new Error("claim owner does not match.");
  }
}

export class WorkboardWorkflowStore extends WorkboardPromoteStore {
  /** D41 pool size for node tickets with a running turn; set once from plugin config. */
  nodeTicketConcurrency = DEFAULT_NODE_TICKET_CONCURRENCY;

  async claim(
    id: string,
    input: WorkboardClaimInput,
    options: WorkboardClaimOptions = {},
  ): Promise<{ card: WorkboardCard; token: string }> {
    const ownerId = normalizeBoundedString(input.ownerId, undefined, 120, "claim owner");
    if (!ownerId) {
      throw new Error("claim ownerId is required.");
    }
    const ttlSeconds = resolveOptionalIntegerOption(input.ttlSeconds, { min: 1 });
    const token =
      normalizeBoundedString(input.token, undefined, 160, "claim token") ?? randomUUID();
    return await this.enqueueMutation(async () => {
      const now = Date.now();
      const expiresAt = addWorkboardDurationMs(
        now,
        ttlSeconds ? secondsToDurationMs(ttlSeconds) : DEFAULT_CLAIM_TTL_MS,
      );
      const guarded = await this.promoteDependencyReady(id, now);
      if (guarded.metadata?.archivedAt) {
        throw new Error("card is archived.");
      }
      const expectedAuthority = options.expectedAuthority;
      if (
        expectedAuthority &&
        (guarded.status !== expectedAuthority.status ||
          cardBoardId(guarded) !== expectedAuthority.boardId ||
          guarded.agentId !== expectedAuthority.agentId ||
          !isDeepStrictEqual(
            guarded.metadata?.automation?.workspace,
            expectedAuthority.workspace,
          ) ||
          !isDeepStrictEqual(
            guarded.metadata?.automation?.workspaceAccess,
            expectedAuthority.workspaceAccess,
          ) ||
          !isDeepStrictEqual(guarded.metadata?.automation?.target, expectedAuthority.target))
      ) {
        throw new Error("card workspace authority changed before claim.");
      }
      const existingClaim = guarded.metadata?.claim;
      const activeClaim =
        existingClaim &&
        (isFutureDateTimestampMs(existingClaim.expiresAt, { nowMs: now }) ||
          // Direct claims must honor the same running-worker heartbeat grace
          // as dispatcher recovery; otherwise they silently steal live tokens.
          (guarded.status === "running" && !isWorkboardClaimReclaimable(existingClaim, now)))
          ? existingClaim
          : undefined;
      if (cardParentIds(guarded).length > 0 && guarded.status !== "ready" && !activeClaim) {
        throw new Error(
          guarded.status === "blocked"
            ? "card is blocked; use workboard_unblock before claiming."
            : "card dependencies are not done.",
        );
      }
      if (guarded.status === "scheduled") {
        throw new Error("card is scheduled for later.");
      }
      if (retryBudgetExhausted(guarded)) {
        throw new Error("card exhausted its retry budget.");
      }
      if (activeClaim) {
        throw new Error(`card already claimed by ${activeClaim.ownerId}.`);
      }
      const metadata = clearDiagnostics(guarded.metadata, ["stranded_ready"]);
      const slot: WorkboardClaimSlot = isWorkboardNodeTicket(guarded)
        ? { kind: "node-tickets", limit: this.nodeTicketConcurrency }
        : { kind: "owner", ownerId };
      const card = await this.updateCard(
        await this.requireCard(id),
        {
          status:
            guarded.status === "backlog" || guarded.status === "todo" || guarded.status === "ready"
              ? "running"
              : guarded.status,
          ...(options.adoptWorkspaceAccess && !guarded.metadata?.automation?.workspaceAccess
            ? { workspaceAccess: options.adoptWorkspaceAccess }
            : {}),
          metadata: {
            ...metadata,
            claim: { ownerId, token, claimedAt: now, lastHeartbeatAt: now, expiresAt },
          },
        },
        {
          expectedUpdatedAt: guarded.updatedAt,
          claimSlot: { slot, busyMessage: workboardSlotBusyMessage(slot), now },
        },
      );
      return { card, token };
    }, options.assertOwnerCurrent);
  }

  async heartbeat(id: string, input: WorkboardHeartbeatInput): Promise<WorkboardCard> {
    const note = normalizeBoundedString(input.note, undefined, 400, "heartbeat note");
    return await this.updateMetadata(id, (existing) => {
      const claim = existing.metadata?.claim;
      if (!claim) {
        throw new Error("card is not claimed.");
      }
      const now = Math.max(Date.now(), claim.lastHeartbeatAt + 1);
      assertClaimIdentity(claim, input);
      const nextClaim = {
        ...claim,
        lastHeartbeatAt: now,
        expiresAt: claim.expiresAt
          ? addWorkboardDurationMs(
              now,
              Math.max(
                1,
                claim.expiresAt > claim.claimedAt
                  ? claim.expiresAt - claim.lastHeartbeatAt
                  : DEFAULT_CLAIM_TTL_MS,
              ),
            )
          : undefined,
      };
      const metadata = clearDiagnostics(existing.metadata, ["running_without_heartbeat"]);
      return {
        ...metadata,
        claim: nextClaim,
        comments: appendComment(metadata.comments, note, now),
      };
    });
  }

  async releaseClaim(
    id: string,
    input: WorkboardHeartbeatInput & { status?: unknown } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      const status =
        input.status === undefined
          ? existing.status
          : normalizeStatus(input.status, existing.status);
      const claim = existing.metadata?.claim;
      if (claim) {
        assertClaimIdentity(claim, input);
      }
      return await this.updateCard(
        await this.requireCard(id),
        {
          status,
          metadata: { ...existing.metadata, claim: undefined },
        },
        { enforceStatusHolds: input.status !== undefined },
      );
    });
  }

  async complete(
    id: string,
    input: WorkboardCompleteInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(() => this.completeDirect(id, input, scope));
  }

  private async completeDirect(
    id: string,
    input: WorkboardCompleteInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    const existing = await this.requireCard(id);
    assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
    const now = Date.now();
    const createdCardIds = normalizeStringList(input.createdCardIds, "created card ids", 120);
    const childIds = cardChildIds(existing);
    for (const createdCardId of createdCardIds) {
      const createdCard = await this.get(createdCardId);
      if (!createdCard) {
        throw new Error(`created card not found: ${createdCardId}`);
      }
      const linkedFromParent =
        childIds.includes(createdCardId) && cardParentIds(createdCard).includes(existing.id);
      if (!linkedFromParent) {
        throw new Error(`created card is not linked to this card: ${createdCardId}`);
      }
    }
    const summary = normalizeBoundedString(input.summary, undefined, 2000, "summary");
    const proofInput = isRecord(input.proof) ? input.proof : undefined;
    const proofId = normalizeBoundedString(input.proofId, undefined, 120, "proof id");
    if (input.proofId !== undefined && !proofId) {
      throw new Error("proofId must be a non-empty string.");
    }
    const proof = proofInput ? normalizeProofInput(proofInput, now) : undefined;
    const artifacts = Array.isArray(input.artifacts)
      ? input.artifacts
          .map((artifact) => normalizeArtifact({ ...artifact, createdAt: now }))
          .filter((artifact): artifact is WorkboardArtifact => artifact !== null)
          .slice(-MAX_CARD_ARTIFACTS)
      : [];
    const metadata = clearDiagnostics(existing.metadata, ["missing_proof"]);
    const notification: WorkboardNotification = {
      id: randomUUID(),
      kind: "completed",
      createdAt: now,
      sequence: this.nextNotificationSequence(now),
      message: capText(summary, 240) ?? "Workboard card completed.",
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    };
    const execution =
      existing.execution?.status === "running"
        ? { ...existing.execution, status: "done" as const, updatedAt: now }
        : existing.execution;
    return await this.updateCard(
      await this.requireCard(id),
      {
        status: "done",
        ...(execution ? { execution } : {}),
        metadata: {
          ...metadata,
          claim: undefined,
          attempts: closeRunningAttempts(metadata.attempts, now, "succeeded"),
          failureCount: 0,
          automation: normalizeAutomation(
            {
              ...metadata.automation,
              summary,
              createdCardIds,
            },
            metadata.automation,
          ),
          comments: appendComment(metadata.comments, summary, now),
          proof: appendCompletionProof(metadata.proof, proof, proofId),
          artifacts: artifacts.length
            ? [...(metadata.artifacts ?? []), ...artifacts].slice(-MAX_CARD_ARTIFACTS)
            : metadata.artifacts,
          notifications: [...(metadata.notifications ?? []), notification].slice(
            -MAX_CARD_NOTIFICATIONS,
          ),
        },
      },
      {
        enforceStatusHolds: true,
        preserveProofId: proofId ?? proof?.id,
      },
    );
  }

  protected buildBlockedCardPatch(
    existing: WorkboardCard,
    reason: string,
    now: number,
    options: { clearExecutionAssociation?: boolean } = {},
  ): WorkboardCardPatch & { metadata: WorkboardMetadata } {
    const metadata = existing.metadata ?? {};
    const notification: WorkboardNotification = {
      id: randomUUID(),
      kind: "failed",
      createdAt: now,
      sequence: this.nextNotificationSequence(now),
      message: capText(reason, 240) ?? "Workboard card blocked.",
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    };
    const execution =
      existing.execution?.status === "running"
        ? { ...existing.execution, status: "blocked" as const, updatedAt: now }
        : existing.execution;
    return {
      status: "blocked",
      ...(options.clearExecutionAssociation
        ? { sessionKey: null, runId: null, execution: null }
        : execution
          ? { execution }
          : {}),
      metadata: {
        ...metadata,
        claim: undefined,
        attempts: closeRunningAttempts(metadata.attempts, now, "blocked", reason),
        failureCount: (metadata.failureCount ?? 0) + 1,
        comments: appendComment(metadata.comments, reason, now),
        notifications: [...(metadata.notifications ?? []), notification].slice(
          -MAX_CARD_NOTIFICATIONS,
        ),
      },
    };
  }

  async block(
    id: string,
    input: WorkboardBlockInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
    options: { clearExecutionAssociation?: boolean } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, MAX_BLOCK_REASON_CHARS, "block reason") ??
        "Workboard card blocked.";
      return await this.updateCard(
        await this.requireCard(id),
        this.buildBlockedCardPatch(existing, reason, now, options),
      );
    });
  }

  /**
   * Adds a Workboard notice to a published node ticket (D56) in the same write
   * that records it on the handoff, so the notice is never mistaken for the
   * review comment that starts the next rework round. A `reviewFrom` notice
   * moves that cutoff past itself; a slot wait is noted once per round.
   */
  async addNodeTicketNotice(
    id: string,
    input: {
      worktreePath: string;
      body: string;
      kind: "reviewFrom" | "slotWait";
      applies: (card: WorkboardCard) => boolean;
      status?: "backlog";
    },
    scope?: WorkboardMutationScope,
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.updateLatestCard(
        id,
        (card) => {
          assertCanMutateClaimedCard(card, scope);
          const target = card.metadata?.automation?.target;
          const handoff = target?.worktree?.handoff;
          if (
            !target?.worktree ||
            target.worktree.path !== input.worktreePath ||
            handoff?.phase !== "published" ||
            !input.applies(card)
          ) {
            return undefined;
          }
          const now = Date.now();
          return {
            ...(input.status ? { status: input.status } : {}),
            metadata: {
              ...card.metadata,
              comments: [
                ...(card.metadata?.comments ?? []),
                { id: randomUUID(), body: input.body, createdAt: now },
              ].slice(-MAX_CARD_COMMENTS),
              automation: {
                ...card.metadata?.automation,
                target: {
                  ...target,
                  worktree: {
                    ...target.worktree,
                    handoff: {
                      ...handoff,
                      ...(input.kind === "reviewFrom"
                        ? { reviewFrom: now }
                        : { slotWaitNotedAt: now }),
                    },
                  },
                },
              },
            },
          };
        },
        { allowAutomationLaunch: true },
      );
    });
  }

  async unblock(id: string, scope?: WorkboardMutationScope): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope);
      const metadata = clearDiagnostics(existing.metadata, ["blocked_too_long"]);
      return await this.updateCard(await this.requireCard(id), {
        status: "todo",
        metadata: { ...metadata, stale: null },
      });
    });
  }

  async reassign(
    id: string,
    input: WorkboardReassignInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const agentId =
        input.agentId === undefined ? existing.agentId : normalizeOptionalString(input.agentId);
      const status =
        input.status === undefined
          ? existing.status
          : normalizeStatus(input.status, existing.status);
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "reassign reason");
      const shouldResetFailures = input.resetFailures !== false;
      const baseMetadata = shouldResetFailures
        ? clearDiagnostics(existing.metadata, ["blocked_too_long", "repeated_failures"])
        : existing.metadata;
      const metadata = {
        ...baseMetadata,
        ...(shouldResetFailures ? { failureCount: 0 } : {}),
        comments: appendComment(baseMetadata?.comments, reason),
      };
      return await this.updateCard(
        await this.requireCard(id),
        { agentId, status, metadata },
        { enforceStatusHolds: true },
      );
    });
  }

  async reclaim(
    id: string,
    input: WorkboardReclaimInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, 1000, "reclaim reason") ??
        "Workboard claim reclaimed.";
      const targetStatus =
        input.status === undefined
          ? existing.status === "running"
            ? "ready"
            : existing.status
          : normalizeStatus(input.status, existing.status);
      const reclaimed = await this.updateCard(
        await this.requireCard(id),
        {
          status: targetStatus,
          execution: existing.execution?.status === "running" ? null : existing.execution,
          metadata: {
            ...existing.metadata,
            claim: undefined,
            attempts: closeRunningAttempts(existing.metadata?.attempts, now, "stopped", reason),
            comments: appendComment(existing.metadata?.comments, reason, now),
            stale: null,
          },
        },
        { enforceStatusHolds: true },
      );
      return await this.promoteDependencyReady(reclaimed.id, now);
    });
  }

  async runs(id: string): Promise<{ card: WorkboardCard; attempts: WorkboardRunAttempt[] }> {
    const card = await this.requireCard(id);
    return { card, attempts: card.metadata?.attempts ?? [] };
  }

  async specify(
    id: string,
    input: WorkboardSpecifyInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      if (
        existing.status !== "triage" &&
        existing.status !== "backlog" &&
        existing.status !== "todo"
      ) {
        throw new Error("only triage, backlog, or todo cards can be specified.");
      }
      const requestedStatus = normalizeStatus(input.status, "todo");
      if (requestedStatus !== "todo") {
        throw new Error("specified cards must move to todo.");
      }
      const now = Date.now();
      const summary = normalizeBoundedString(input.summary, undefined, 2000, "spec summary");
      const metadata = {
        ...existing.metadata,
        comments: appendComment(existing.metadata?.comments, summary, now),
        automation: normalizeAutomation(
          {
            ...existing.metadata?.automation,
            summary: summary ?? existing.metadata?.automation?.summary,
          },
          existing.metadata?.automation,
        ),
      };
      const { summary: _summary, status: _status, ...cardPatch } = input;
      return await this.updateCard(
        await this.requireCard(id),
        {
          ...cardPatch,
          status: "todo",
          metadata,
        },
        { enforceStatusHolds: true, event: { kind: "specified" }, eventAt: now },
      );
    });
  }

  async decompose(
    id: string,
    input: WorkboardDecomposeInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<{ parent: WorkboardCard; children: WorkboardCard[] }> {
    return await this.enqueueMutation(
      async () =>
        await this.withCardCompensation(async () => {
          const parent = await this.requireCard(id);
          assertCanMutateClaimedCard(parent, scope === null ? undefined : scope);
          const childrenInput = Array.isArray(input.children) ? input.children : [];
          if (childrenInput.length === 0) {
            throw new Error("children are required.");
          }
          if (childrenInput.length > 20) {
            throw new Error("at most 20 children can be created at once.");
          }
          const parentAutomation = parent.metadata?.automation;
          const children: WorkboardCard[] = [];
          for (const child of childrenInput) {
            if (!isRecord(child)) {
              throw new Error("children must be objects.");
            }
            const created = await this.createDirect(
              {
                ...child,
                parents: [parent.id],
                boardId: child.boardId ?? parentAutomation?.boardId,
                tenant: child.tenant ?? parentAutomation?.tenant,
                createdByCardId: parent.id,
                idempotencyKey:
                  child.idempotencyKey ??
                  deriveChildIdempotencyKey(parentAutomation?.idempotencyKey, children.length + 1),
              },
              scope === null ? undefined : scope,
            );
            children.push(
              cardParentIds(created).includes(parent.id)
                ? created
                : await this.linkCardsDirect(parent.id, created.id, Date.now(), {
                    allowStatusOnlyActiveChild: true,
                    scope: scope === null ? undefined : scope,
                  }),
            );
          }
          const summary = normalizeBoundedString(
            input.summary,
            undefined,
            2000,
            "decompose summary",
          );
          const completeParent = input.completeParent !== false;
          const updatedParent = completeParent
            ? await this.completeDirect(
                parent.id,
                { summary, createdCardIds: children.map((child) => child.id) },
                scope,
              )
            : await (async () => {
                const latestParent = (await this.get(parent.id)) ?? parent;
                return await this.updateCard(
                  await this.requireCard(parent.id),
                  {
                    status:
                      latestParent.status === "triage" || latestParent.status === "backlog"
                        ? "todo"
                        : latestParent.status,
                    metadata: {
                      ...latestParent.metadata,
                      automation: normalizeAutomation(
                        {
                          ...latestParent.metadata?.automation,
                          summary,
                          createdCardIds: children.map((child) => child.id),
                        },
                        latestParent.metadata?.automation,
                      ),
                    },
                  },
                  { enforceStatusHolds: true },
                );
              })();
          const decomposedParent = await this.updateCard(
            await this.requireCard(updatedParent.id),
            {},
            {
              event: { kind: "decomposed" },
              expectedUpdatedAt: updatedParent.updatedAt,
            },
          );
          return { parent: decomposedParent, children };
        }),
    );
  }
}
