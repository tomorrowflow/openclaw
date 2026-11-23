import type {
  WorkboardCard,
  WorkboardSessionsBoardRead,
  WorkboardSessionsBoardView,
} from "@openclaw/workboard-contract";
import { readStringParam } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  captureLocalStateMutationGuard,
  ErrorCodes,
  errorShape,
} from "openclaw/plugin-sdk/gateway-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  isRecord,
  asRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import type { OpenClawPluginApi } from "../api.js";
import { redactDispatchResult, redactOperatorCard } from "./card-redaction.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { registerWorkboardBoardMethods } from "./gateway-boards.js";
import { registerNodeTicketReadMethods } from "./gateway-node-ticket-reads.js";
import type { WorkboardHealthReader } from "./health.js";
import type { WorkboardLifecycleSessionReader } from "./lifecycle-sessions.js";
import { readNodeGrillResult } from "./node-ticket-grill-session.js";
import type { WorkboardSessionsBoardService } from "./sessions-board.js";
import { resolveWorkboardSqliteWorkerModuleUrl } from "./sqlite-store-paths.js";
import { cardRunId, cardSessionKey } from "./store-card-helpers.js";
import { registerWorkboardStoreLifecycle } from "./store-lifecycle.js";
import { assertSupportedMetadataKeys } from "./store-metadata-keys.js";
import { WorkboardCardConflictError, WorkboardStore } from "./store.js";
import {
  assertWorkboardWorkspaceMutationAccess,
  canonicalizeWorkboardWorkspaceAccess,
  resolveAgentWorkboardWorkspaceRuntime,
  resolveConfiguredWorkboardWorkspaceAccess,
  resolveWorkboardAgentWorkspace,
  type WorkboardWorkspaceAccess,
  containsWorkboardWorkspaceMutation,
  withWorkboardDecomposeWorkspaceAccess,
  withWorkboardWorkspaceAccess,
  withoutWorkboardWorkspaceAccess,
} from "./workspace-access.js";

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];

type GatewayRespond = GatewayMethodContext["respond"];

class WorkboardUploadsDisabledError extends Error {
  constructor() {
    super("File and image uploads are disabled by gateway.uploads.enabled");
    this.name = "WorkboardUploadsDisabledError";
  }
}

function respondError(respond: GatewayRespond, error: unknown) {
  if (error instanceof WorkboardUploadsDisabledError) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, error.message, { details: { code: "UPLOADS_DISABLED" } }),
    );
    return;
  }
  if (error instanceof WorkboardCardConflictError) {
    respond(false, undefined, {
      code: "workboard_conflict",
      message: error.message,
      details: {
        type: "workboard_card_conflict",
        card: redactOperatorCard(error.current),
      },
    });
    return;
  }
  respond(false, undefined, {
    code: "workboard_error",
    message: formatErrorMessage(error),
  });
}

function readExpectedUpdatedAt(params: Record<string, unknown>): number | undefined {
  const value = params.expectedUpdatedAt;
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("expectedUpdatedAt must be a finite number.");
  }
  return value;
}

function readId(params: Record<string, unknown>): string {
  const value = params.id;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error("id is required.");
}

function readOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (typeof value !== "number" || parsed === undefined) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function readPatch(params: Record<string, unknown>): Record<string, unknown> {
  return isRecord(params.patch) ? params.patch : params;
}

function assertNoCursorAdvance(params: Record<string, unknown>) {
  if (params.advance === true) {
    throw new Error("notification cursor advancement requires workboard.notifications.advance.");
  }
}

/**
 * In-process plugin dispatch has no remote client and already runs with host
 * authority; a connected client is an admin only with operator.admin.
 */
function callerHasAdmin(client: GatewayMethodContext["client"]): boolean {
  if (!client) {
    return true;
  }
  const scopes = Array.isArray(client.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes("operator.admin");
}

function resolveGatewayWorkboardWorkspaceAccess(params: {
  context: GatewayMethodContext["context"];
  client: GatewayMethodContext["client"];
}): WorkboardWorkspaceAccess {
  // Connected write-scope clients stay within configured workspaces.
  if (callerHasAdmin(params.client)) {
    return { unrestricted: true };
  }
  return resolveConfiguredWorkboardWorkspaceAccess({
    config: params.context.getRuntimeConfig(),
    unrestricted: false,
  });
}

async function resolveGatewayWorkspaceMutationAccess(
  request: GatewayMethodContext,
  value: unknown,
): Promise<WorkboardWorkspaceAccess> {
  const access = await canonicalizeWorkboardWorkspaceAccess(
    resolveGatewayWorkboardWorkspaceAccess(request),
  );
  await assertWorkboardWorkspaceMutationAccess(value, access);
  return access;
}

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
const ADMIN_SCOPE = "operator.admin" as const;
const mergeDigestParamsSchema = z.object({ since: z.number().int().min(0).optional() });
const visualCheckParamsSchema = z.object({
  verdict: z.enum(["looks_right", "problem"]),
  note: z.string().optional(),
});
const cardsListFilterSchema = z.object({
  sessionKey: z.string().trim().min(1).optional(),
  after: z
    .object({
      position: z.number().finite(),
      createdAt: z.number().finite(),
      id: z.string().min(1),
    })
    .optional(),
});
const CLI_OWNER_METHODS = new Set([
  "workboard.cards.list",
  "workboard.cards.create",
  "workboard.cards.move",
  "workboard.cards.dispatch",
  "workboard.cards.dispatchWithOptions",
]);

function sessionsBoardView(input: Record<string, unknown>): WorkboardSessionsBoardView | undefined {
  const unknownParam = Object.keys(input).find(
    (key) => key !== "boardId" && key !== "view" && key !== "sinceRevision" && key !== "after",
  );
  if (unknownParam) {
    throw new Error(`Unknown Sessions board read field: ${unknownParam}.`);
  }
  if (input.view === undefined) {
    return undefined;
  }
  if (!isRecord(input.view)) {
    throw new Error("view must be an object.");
  }
  const view: WorkboardSessionsBoardView = {};
  for (const [key, value] of Object.entries(input.view)) {
    switch (key) {
      case "involvingMe":
      case "includePeople":
        if (typeof value !== "boolean") {
          throw new Error(`view.${key} must be a boolean.`);
        }
        view[key] = value;
        break;
      case "involvingProfileId":
        if (typeof value !== "string") {
          throw new Error("view.involvingProfileId must be a string.");
        }
        view.involvingProfileId = value;
        break;
      default:
        throw new Error(`Unknown Sessions board view field: ${key}.`);
    }
  }
  return view;
}

function sessionsBoardPage(
  result: WorkboardSessionsBoardRead,
  after?: string,
): WorkboardSessionsBoardRead {
  const previous =
    after === undefined ? -1 : result.sessions.findIndex((session) => session.key === after);
  if (after !== undefined && previous < 0) {
    throw new Error("This Sessions board page has changed. Refresh the board to continue.");
  }
  const start = previous + 1;
  const sessions = result.sessions.slice(start, start + 100);
  return {
    ...result,
    sessions,
    total: result.sessions.length,
    ...(start + sessions.length < result.sessions.length
      ? { nextCursor: sessions.at(-1)!.key }
      : {}),
  };
}

/**
 * Interactive Sessions-board writes wait in the store's mutation queue, so the
 * caller's full Gateway authority (transport, role/scope/profile authorization,
 * in-process lifetime) is rechecked immediately before the SQLite write.
 */
function sessionsBoardCaller(
  context: Pick<
    GatewayMethodContext,
    | "hasCurrentClientAuthority"
    | "sessionMutationAuthorization"
    | "sessionAccessAuthority"
    | "sessionMutationCommitGuard"
    | "signal"
  >,
) {
  return {
    assertCurrent() {
      context.signal?.throwIfAborted();
      if (context.hasCurrentClientAuthority?.() === false) {
        throw new Error("Caller authority is no longer active.");
      }
      context.sessionAccessAuthority?.assertCurrent();
      context.sessionMutationAuthorization?.assertCurrent();
      context.sessionMutationCommitGuard?.();
    },
  };
}

function redactDiagnosticsRows(result: Awaited<ReturnType<WorkboardStore["diagnostics"]>>) {
  return {
    ...result,
    diagnostics: result.diagnostics.map((row) => ({
      ...row,
      card: redactOperatorCard(row.card),
    })),
  };
}

async function redactCardResult(card: Promise<WorkboardCard>) {
  return { card: redactOperatorCard(await card) };
}

export function registerWorkboardGatewayMethods(params: {
  api: OpenClawPluginApi;
  store?: WorkboardStore;
  sessionsBoard?: Pick<WorkboardSessionsBoardService, "read" | "update" | "move">;
  readSessions?: WorkboardLifecycleSessionReader;
  onOperatorComment?: (input: {
    cards: readonly WorkboardCard[];
    sessionKey?: string;
    operatorComment: true;
  }) => Promise<void>;
  health?: WorkboardHealthReader;
}) {
  const { api } = params;
  const assertUploadsAllowed = (client: GatewayMethodContext["client"]) => {
    if (
      !client?.internal?.syntheticClient &&
      !client?.internal?.agentRuntimeIdentity &&
      api.runtime.config.current().gateway?.uploads?.enabled === false
    ) {
      throw new WorkboardUploadsDisabledError();
    }
  };
  const store =
    params.store ??
    WorkboardStore.openSqlite(resolveWorkboardSqliteWorkerModuleUrl(api.runtimeSource));
  if (!params.store) {
    registerWorkboardStoreLifecycle(api, store);
  }
  const register = (
    method: string,
    scope: typeof READ_SCOPE | typeof WRITE_SCOPE | typeof ADMIN_SCOPE,
    handler: (request: GatewayMethodContext) => unknown,
  ) => {
    const requestHandler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1] = async (
      initialRequest,
    ) => {
      let request = initialRequest;
      let assertOwnerCurrent: (() => void) | undefined;
      if (request.params?.expectedOwnerId !== undefined) {
        try {
          const expectedOwnerId = readStringParam(request.params, "expectedOwnerId", {
            required: true,
          });
          assertOwnerCurrent = captureLocalStateMutationGuard(expectedOwnerId, request);
        } catch (error) {
          request.respond(false, undefined, {
            code: "UNAVAILABLE",
            message: String(error),
            details: { mutationAccepted: false },
          });
          return;
        }
        const { expectedOwnerId: _expectedOwnerId, ...input } = request.params;
        const previousGuard = request.sessionMutationCommitGuard;
        request = {
          ...request,
          params: input,
          sessionMutationCommitGuard: () => {
            previousGuard?.();
            assertOwnerCurrent?.();
          },
        };
      }
      try {
        await store.runOperation(async () => {
          assertOwnerCurrent?.();
          if (method === "workboard.cards.attachments.add") {
            assertUploadsAllowed(request.client);
          }
          request.respond(true, await handler(request));
        });
      } catch (error) {
        respondError(request.respond, error);
      }
    };
    api.registerGatewayMethod(method, requestHandler, { scope });
    if (CLI_OWNER_METHODS.has(method)) {
      api.registerGatewayMethod(
        `${method}.owner`,
        (request) => {
          if (
            typeof request.params?.expectedOwnerId !== "string" ||
            !request.params.expectedOwnerId.trim()
          ) {
            request.respond(false, undefined, {
              code: "INVALID_REQUEST",
              message: "expectedOwnerId is required",
              details: { mutationAccepted: false },
            });
            return;
          }
          return requestHandler(request);
        },
        { scope },
      );
    }
  };
  const cardMutation = (
    method: string,
    mutate: (id: string, input: Record<string, unknown>) => Promise<WorkboardCard>,
  ) =>
    register(`workboard.cards.${method}`, WRITE_SCOPE, ({ params: input }) =>
      redactCardResult(mutate(readId(input), input)),
    );
  const prepareWorkspaceInput = async (
    request: GatewayMethodContext,
    value: unknown,
    kind: "create" | "patch" | "decompose",
  ) => {
    const input = withoutWorkboardWorkspaceAccess(value);
    const access = await resolveGatewayWorkspaceMutationAccess(request, input);
    return kind === "decompose"
      ? withWorkboardDecomposeWorkspaceAccess(input, access)
      : kind === "create" || containsWorkboardWorkspaceMutation(input)
        ? withWorkboardWorkspaceAccess(input, access)
        : input;
  };
  const dispatchCards = async (
    { params: requestParams, client, context, sessionMutationCommitGuard }: GatewayMethodContext,
    options: { supportsMaxStarts: boolean; directCard?: boolean },
  ) => {
    const cardId = options.directCard ? readId(requestParams) : undefined;
    const { boardId, maxStarts: rawMaxStarts } = asRecord(requestParams);
    if (!options.supportsMaxStarts && rawMaxStarts !== undefined) {
      throw new Error("maxStarts requires workboard.cards.dispatchWithOptions.");
    }
    const maxStarts = options.supportsMaxStarts
      ? readOptionalPositiveInteger(rawMaxStarts, "maxStarts")
      : undefined;
    const provider = options.directCard
      ? normalizeOptionalString(requestParams.provider)
      : undefined;
    const model = options.directCard ? normalizeOptionalString(requestParams.model) : undefined;
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: api.runtime.subagent,
      worktrees: api.runtime.worktrees,
      nodeTickets: api.runtime.gateway,
      options: {
        // The operator's Start queues a node ticket whose slot is full.
        ...(cardId ? { cardId, maxStarts: 1, queue: "request" as const } : {}),
        boardId: typeof boardId === "string" ? boardId : undefined,
        ...(maxStarts !== undefined ? { maxStarts } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        materializeWorktree: true,
        assertOwnerCurrent: sessionMutationCommitGuard,
        resolveAgentWorkspace: (agentId) =>
          resolveWorkboardAgentWorkspace(context.getRuntimeConfig(), agentId),
        resolveAgentWorkspaceRuntime: (
          agentId,
          sessionKey,
          workspaceDir,
          modelProvider,
          modelId,
        ) => {
          const config = context.getRuntimeConfig();
          return resolveAgentWorkboardWorkspaceRuntime({
            config,
            agentId,
            sessionKey,
            workspaceDir,
            modelProvider,
            modelId,
            prepareSandboxWorkspaceAuthority: api.runtime.sandbox.prepareWorkspaceAuthority,
          });
        },
        workspaceAccess: resolveGatewayWorkboardWorkspaceAccess({ context, client }),
      },
    });
    if (cardId) {
      if (result.queued) {
        return { queued: true, card: redactOperatorCard(result.queued) };
      }
      const started = result.started[0];
      if (!started?.card) {
        throw new Error(result.startFailures[0]?.error ?? "Workboard card did not start.");
      }
      return { ...started, card: redactOperatorCard(started.card) };
    }
    return redactDispatchResult(result);
  };
  const viewerPort = (key: "transcriptViewer" | "officeViewer" | "architectureViewer") => {
    const viewer = api.pluginConfig?.[key];
    return isRecord(viewer) && typeof viewer.port === "number" ? viewer.port : null;
  };
  const transcriptViewerPort = viewerPort("transcriptViewer");
  const officeViewerPort = viewerPort("officeViewer");
  const architectureViewerPort = viewerPort("architectureViewer");

  register("workboard.cards.list", READ_SCOPE, async ({ params: input }) => {
    const { sessionKey, after } = cardsListFilterSchema.parse(input);
    const result = await store.listCards(input.boardId, sessionKey, after);
    const since = input.sinceRevision;
    return after === undefined &&
      isRecord(since) &&
      since.epoch === result.revision.epoch &&
      since.revision === result.revision.revision &&
      since.boardId === result.revision.boardId &&
      since.sessionKey === result.revision.sessionKey
      ? { unchanged: true, revision: result.revision }
      : result;
  });
  for (const method of ["create", "captureSession"] as const) {
    register(`workboard.cards.${method}`, WRITE_SCOPE, async (request) => {
      const prepared = await prepareWorkspaceInput(request, request.params, "create");
      assertSupportedMetadataKeys(prepared.metadata);
      return redactCardResult(
        method === "create"
          ? store.create(prepared, undefined, request.sessionMutationCommitGuard)
          : store.captureSession(prepared),
      );
    });
  }
  register("workboard.cards.update", WRITE_SCOPE, async (request) => {
    const patch = await prepareWorkspaceInput(request, readPatch(request.params), "patch");
    assertSupportedMetadataKeys(patch.metadata);
    const expectedUpdatedAt = readExpectedUpdatedAt(request.params);
    return redactCardResult(store.update(readId(request.params), patch, { expectedUpdatedAt }));
  });
  register("workboard.cards.start", WRITE_SCOPE, (request) =>
    dispatchCards(request, { supportsMaxStarts: false, directCard: true }),
  );
  // The stop is recorded before the abort so the run's end reads as a stop, not a failure.
  register("workboard.cards.stop", WRITE_SCOPE, async ({ params: input }) => {
    const id = readId(input);
    const requested = await store.nodeTicketStop(id, {
      action: "request",
      expectedUpdatedAt: readExpectedUpdatedAt(input),
    });
    // Another stop is already in flight; its abort and settle own the card.
    if (!requested.updated) {
      return { card: redactOperatorCard(requested.card) };
    }
    const sessionKey = cardSessionKey(requested.card);
    const runId = cardRunId(requested.card);
    // chat.abort needs operator.write, the scope this method already requires.
    const abort = async (abortParams: Record<string, unknown>) => {
      const result = await api.runtime.gateway.request("chat.abort", abortParams, {
        scopes: ["operator.write"],
      });
      return (
        isRecord(result) &&
        (result.aborted === true || (Array.isArray(result.runIds) && result.runIds.length > 0))
      );
    };
    let aborted: boolean;
    try {
      // A stale card run id aborts nothing; retry session-wide before giving up.
      aborted =
        (await abort({ sessionKey, ...(runId ? { runId } : {}) })) ||
        (runId !== undefined && (await abort({ sessionKey })));
    } catch (error) {
      await store.nodeTicketStop(id, { action: "settle", aborted: false });
      throw error;
    }
    const { card } = await store.nodeTicketStop(id, { action: "settle", aborted });
    // The run's end may have settled the stop before the abort found nothing to abort.
    const stopped =
      card.status === "todo" &&
      card.metadata?.automation?.target?.worktree?.stopRequestedAt !== undefined;
    if (!aborted && !stopped) {
      throw new Error("The ticket session had no active run to stop; refresh the card.");
    }
    return { card: redactOperatorCard(card) };
  });
  register("workboard.cards.sampleRead", WRITE_SCOPE, ({ params: input }) =>
    redactCardResult(store.readNodeTicketSample(readId(input))),
  );
  register("workboard.cards.dismissRegression", WRITE_SCOPE, ({ params: input }) =>
    redactCardResult(store.dismissMergeRegression(readId(input))),
  );
  register("workboard.cards.setModel", WRITE_SCOPE, ({ params: input }) =>
    redactCardResult(
      store.setTargetModel(readId(input), readStringParam(input, "model", { required: true })),
    ),
  );
  // The card change wakes the node handoff owner, which starts a fresh verification.
  register("workboard.cards.verify", WRITE_SCOPE, ({ params: input }) =>
    redactCardResult(store.dropNodeVerification(readId(input))),
  );
  // The card change wakes the preview pass, which tears the failed preview down and starts it again.
  register("workboard.cards.preview.retry", WRITE_SCOPE, ({ params: input }) =>
    redactCardResult(store.retryNodePreview(readId(input))),
  );
  register("workboard.cards.visualCheck", WRITE_SCOPE, ({ params: input }) => {
    const { verdict, note } = visualCheckParamsSchema.parse(input);
    return redactCardResult(
      store.setNodeVisualCheck(readId(input), { verdict, ...(note ? { note } : {}) }),
    );
  });
  // A repeat returns the source's unarchived probe of the arm; `start` then starts it if still todo.
  register("workboard.cards.probe", ADMIN_SCOPE, async (request) => {
    const input = request.params;
    const optional = (key: "model" | "note") => {
      const value = input[key];
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`${key} must be a string.`);
      }
      return value?.trim() || undefined;
    };
    if (typeof input.arm !== "string") {
      throw new Error("arm is required.");
    }
    const model = optional("model");
    const note = optional("note");
    const { card, created } = await store.createNodeProbe(readId(input), {
      arm: input.arm.trim(),
      ...(model ? { model } : {}),
      ...(note ? { note } : {}),
    });
    if (input.start !== true || card.status !== "todo" || card.metadata?.automation?.startRequest) {
      return { card: redactOperatorCard(card), created };
    }
    // The operator's Start: queued while the node-ticket slots are full.
    const started = await dispatchCards(
      { ...request, params: { id: card.id } },
      { supportsMaxStarts: false, directCard: true },
    );
    return { ...started, created };
  });
  register("workboard.cards.probes", READ_SCOPE, ({ params: input }) => store.probes(input));
  // The move to todo an end makes wakes the node handoff owner, which resumes the session.
  register("workboard.cards.grill.end", WRITE_SCOPE, async ({ params: input }) => {
    const id = readId(input);
    const card = await store.get(id);
    const read = await readNodeGrillResult(
      api.runtime.gateway,
      params.readSessions,
      card?.metadata?.automation?.target?.worktree?.grill?.sessionKey,
    ).catch((error: unknown) => {
      throw new Error("Could not read the grill session; try End grilling again.", {
        cause: error,
      });
    });
    if (read.replying) {
      throw new Error(
        "The agent is still replying in the grill session; end the grilling when it has answered.",
      );
    }
    return await redactCardResult(store.endNodeGrill(id, read.result));
  });
  // Like a grill report, the change wakes the node handoff owner, which opens the grill session.
  register("workboard.cards.grill.questions", WRITE_SCOPE, ({ params: input }) =>
    redactCardResult(store.grillNodeQuestions(readId(input))),
  );
  register("workboard.cards.move", WRITE_SCOPE, ({ params: input, sessionMutationCommitGuard }) =>
    redactCardResult(
      store.move(readId(input), input.status, input.position, undefined, {
        expectedUpdatedAt: readExpectedUpdatedAt(input),
        assertOwnerCurrent: sessionMutationCommitGuard,
      }),
    ),
  );
  register("workboard.cards.delete", WRITE_SCOPE, ({ params: input }) =>
    store.delete(readId(input), { expectedUpdatedAt: readExpectedUpdatedAt(input) }),
  );
  register("workboard.cards.comment", WRITE_SCOPE, async ({ params: input, client }) => {
    const card = await store.addComment(readId(input), { body: input.body }, undefined, "operator");
    // A decision posted on a card must not wait for the board job's schedule.
    await params.onOperatorComment?.({
      cards: [card],
      sessionKey: client?.internal?.agentRuntimeIdentity?.sessionKey,
      operatorComment: true,
    });
    return { card: redactOperatorCard(card) };
  });
  cardMutation("link", (id, input) => store.addLink(id, input));
  register("workboard.cards.linkDependency", WRITE_SCOPE, ({ params: input }) => {
    const { parentId, childId } = input;
    if (typeof parentId !== "string" || typeof childId !== "string") {
      throw new Error("parentId and childId are required.");
    }
    return redactCardResult(store.linkCards(parentId, childId));
  });
  cardMutation("proof", (id, input) => store.addProof(id, input));
  cardMutation("artifact", (id, input) => store.addArtifact(id, input));
  register("workboard.cards.claim", WRITE_SCOPE, async ({ params: input }) => {
    const claimed = await store.claim(readId(input), input);
    return { ...claimed, card: redactOperatorCard(claimed.card) };
  });
  cardMutation("heartbeat", (id, input) => store.heartbeat(id, input));
  cardMutation("release", (id, input) => store.releaseClaim(id, input));
  cardMutation("promote", (id, input) => store.promote(id, input, null));
  cardMutation("reassign", (id, input) => store.reassign(id, input, null));
  cardMutation("reclaim", (id, input) => store.reclaim(id, input, null));
  cardMutation("complete", (id, input) => store.complete(id, input, null));
  cardMutation("block", (id, input) => store.block(id, input, null));
  cardMutation("unblock", (id) => store.unblock(id));
  register("workboard.cards.bulk", WRITE_SCOPE, async (request) => {
    const input = withoutWorkboardWorkspaceAccess(request.params);
    const result = await store.bulkUpdate({
      ...input,
      patch: await prepareWorkspaceInput(request, readPatch(request.params), "patch"),
    });
    return { cards: result.cards.map(redactOperatorCard) };
  });
  register("workboard.cards.diagnostics", READ_SCOPE, async () =>
    redactDiagnosticsRows(await store.diagnostics()),
  );
  register("workboard.cards.diagnostics.refresh", WRITE_SCOPE, async () =>
    redactDiagnosticsRows(await store.refreshDiagnostics()),
  );
  register("workboard.cards.dispatch", WRITE_SCOPE, (request) =>
    dispatchCards(request, { supportsMaxStarts: false }),
  );
  register("workboard.cards.dispatchWithOptions", WRITE_SCOPE, (request) =>
    dispatchCards(request, { supportsMaxStarts: true }),
  );
  registerWorkboardBoardMethods({
    register,
    store,
    logger: api.logger,
    hasAdmin: callerHasAdmin,
    authorizeUpsert: (request) => resolveGatewayWorkspaceMutationAccess(request, request.params),
  });
  const sessionsBoard = () => {
    if (!params.sessionsBoard) {
      throw new Error("Sessions board service is unavailable.");
    }
    return params.sessionsBoard;
  };
  register("workboard.sessionsBoard.read", READ_SCOPE, async (request) => {
    const after =
      request.params.after === undefined
        ? undefined
        : readStringParam(request.params, "after", { required: true });
    const result = await sessionsBoard().read(
      readStringParam(request.params, "boardId", { required: true }),
      sessionsBoardView(request.params),
      sessionsBoardCaller(request),
    );
    const since = request.params.sinceRevision;
    return after === undefined &&
      isRecord(since) &&
      result.revision &&
      since.epoch === result.revision.epoch &&
      since.revision === result.revision.revision &&
      since.boardId === result.revision.boardId &&
      since.scope === result.revision.scope
      ? { unchanged: true, revision: result.revision }
      : sessionsBoardPage(result, after);
  });
  register("workboard.sessionsBoard.update", WRITE_SCOPE, async (request) => {
    const input = request.params;
    const boardId = readStringParam(input, "boardId", { required: true });
    if (!isRecord(input.patch)) {
      throw new Error("patch must be an object.");
    }
    return {
      board: await sessionsBoard().update(boardId, input.patch, sessionsBoardCaller(request)),
    };
  });
  register("workboard.sessionsBoard.move", WRITE_SCOPE, async (request) =>
    sessionsBoardPage(
      await sessionsBoard().move(
        readStringParam(request.params, "boardId", { required: true }),
        readStringParam(request.params, "sessionKey", { required: true }),
        readStringParam(request.params, "columnId", { required: true }),
        sessionsBoardCaller(request),
      ),
    ),
  );
  register("workboard.cards.stats", READ_SCOPE, ({ params: input }) =>
    store.stats({ boardId: input.boardId }),
  );
  register("workboard.cards.trust", READ_SCOPE, ({ params: input }) =>
    store.trust({ boardId: input.boardId }),
  );
  register("workboard.cards.mergeDigest", READ_SCOPE, ({ params: input }) => {
    const { since } = mergeDigestParamsSchema.parse(input);
    return store.mergeDigest({ boardId: input.boardId, ...(since === undefined ? {} : { since }) });
  });
  register("workboard.overview", READ_SCOPE, ({ params: input }) => store.overview(input.boardId));
  register("workboard.health", READ_SCOPE, () => {
    if (!params.health) {
      throw new Error("Workboard health is unavailable.");
    }
    return params.health.read();
  });
  register("workboard.transcriptViewer", READ_SCOPE, () => ({ port: transcriptViewerPort }));
  register("workboard.officeViewer", READ_SCOPE, () => ({ port: officeViewerPort }));
  register("workboard.architectureViewer", READ_SCOPE, () => ({ port: architectureViewerPort }));
  register("workboard.cards.runs", READ_SCOPE, async ({ params: input }) => {
    const result = await store.runs(readId(input));
    return { ...result, card: redactOperatorCard(result.card) };
  });
  register("workboard.cards.specify", WRITE_SCOPE, async (request) => {
    return redactCardResult(
      store.specify(
        readId(request.params),
        await prepareWorkspaceInput(request, request.params, "patch"),
        null,
      ),
    );
  });
  register("workboard.cards.decompose", WRITE_SCOPE, async (request) => {
    const result = await store.decompose(
      readId(request.params),
      await prepareWorkspaceInput(request, request.params, "decompose"),
      null,
    );
    return {
      parent: redactOperatorCard(result.parent),
      children: result.children.map(redactOperatorCard),
    };
  });
  register("workboard.notifications.subscribe", WRITE_SCOPE, async ({ params: input }) => ({
    subscription: await store.subscribeNotifications(input),
  }));
  register("workboard.notifications.list", READ_SCOPE, ({ params: input }) =>
    store.listNotificationSubscriptions(input),
  );
  register("workboard.notifications.delete", WRITE_SCOPE, ({ params: input }) =>
    store.deleteNotificationSubscription(readId(input)),
  );
  register("workboard.notifications.events", READ_SCOPE, ({ params: input }) => {
    assertNoCursorAdvance(input);
    return store.notificationEvents(input);
  });
  register("workboard.notifications.advance", WRITE_SCOPE, ({ params: input }) =>
    store.advanceNotificationEvents(input),
  );
  register("workboard.cards.attachments.list", READ_SCOPE, async ({ params: input }) => {
    const result = await store.listAttachments(readId(input));
    return { ...result, card: redactOperatorCard(result.card) };
  });
  register("workboard.cards.attachments.get", READ_SCOPE, async ({ params: input }) => {
    const attachment = await store.getAttachment(readId(input));
    if (!attachment) {
      throw new Error(`attachment not found: ${readId(input)}`);
    }
    return attachment;
  });
  registerNodeTicketReadMethods({
    register: (method, handler) =>
      register(method, READ_SCOPE, ({ params: input }) => handler(input)),
    requireCard: async (input) => {
      const id = readId(input);
      const card = await store.get(id);
      if (!card) {
        throw new Error(`card not found: ${id}`);
      }
      return card;
    },
    store,
    runtime: api.runtime.gateway,
  });
  register("workboard.cards.attachments.add", WRITE_SCOPE, ({ params: input, client }) =>
    redactCardResult(
      store.addAttachment(readId(input), input, undefined, () => assertUploadsAllowed(client)),
    ),
  );
  register("workboard.cards.attachments.delete", WRITE_SCOPE, ({ params: input }) => {
    const attachmentId = input.attachmentId;
    if (typeof attachmentId !== "string" || !attachmentId.trim()) {
      throw new Error("attachmentId is required.");
    }
    return redactCardResult(store.deleteAttachment(readId(input), attachmentId.trim()));
  });
  cardMutation("workerLog", (id, input) => store.addWorkerLog(id, input));
  cardMutation("protocolViolation", (id, input) => store.recordProtocolViolation(id, input));
  register("workboard.cards.archive", WRITE_SCOPE, ({ params: input }) =>
    redactCardResult(
      store.archive(readId(input), input.archived, {
        expectedUpdatedAt: readExpectedUpdatedAt(input),
      }),
    ),
  );
  register("workboard.cards.export", READ_SCOPE, async () => {
    const exported = await store.exportCards();
    return { ...exported, cards: exported.cards.map(redactOperatorCard) };
  });
}
