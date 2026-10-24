import type { WorkboardCard, WorkboardSessionsBoardView } from "@openclaw/workboard-contract";
import { readStringParam } from "openclaw/plugin-sdk/core";
import { captureLocalStateMutationGuard } from "openclaw/plugin-sdk/gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import type { OpenClawPluginApi } from "../api.js";
import { redactOperatorCard } from "./card-redaction.js";
import {
  assertNoCursorAdvance,
  createWorkboardDispatchHandler,
  readId,
  readExpectedUpdatedAt,
  readPatch,
  resolveGatewayWorkspaceMutationAccess,
  respondError,
  WorkboardUploadsDisabledError,
  type GatewayMethodContext,
} from "./gateway-helpers.js";
import type { WorkboardLifecycleSessionReader } from "./lifecycle-sync.js";
import {
  listNodeTicketArtifacts,
  type NodeTicketArtifactKind,
  readNodeTicketArtifact,
  relatedCardIds,
} from "./node-ticket-artifacts.js";
import { readNodeTicketChangeDiff } from "./node-ticket-changes.js";
import { readNodeGrillResult } from "./node-ticket-grill-session.js";
import type { WorkboardSessionsBoardService } from "./sessions-board.js";
import { resolveWorkboardSqliteWorkerModuleUrl } from "./sqlite-store-paths.js";
import { cardRunId, cardSessionKey } from "./store-card-helpers.js";
import { registerWorkboardStoreLifecycle } from "./store-lifecycle.js";
import { WorkboardStore } from "./store.js";
import {
  containsWorkboardWorkspaceMutation,
  withWorkboardDecomposeWorkspaceAccess,
  withWorkboardWorkspaceAccess,
  withoutWorkboardWorkspaceAccess,
} from "./workspace-access.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
const cardsListFilterSchema = z.object({ sessionKey: z.string().trim().min(1).optional() });
const CLI_OWNER_METHODS = new Set([
  "workboard.cards.list",
  "workboard.cards.create",
  "workboard.cards.move",
  "workboard.cards.dispatch",
  "workboard.cards.dispatchWithOptions",
]);

function sessionsBoardView(input: Record<string, unknown>): WorkboardSessionsBoardView | undefined {
  const unknownParam = Object.keys(input).find(
    (key) => key !== "boardId" && key !== "view" && key !== "sinceRevision",
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
    scope: typeof READ_SCOPE | typeof WRITE_SCOPE,
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
  const dispatchCards = createWorkboardDispatchHandler({ api, store });
  const transcriptViewer = api.pluginConfig?.transcriptViewer;
  const transcriptViewerPort =
    isRecord(transcriptViewer) && typeof transcriptViewer.port === "number"
      ? transcriptViewer.port
      : null;

  register("workboard.cards.list", READ_SCOPE, async ({ params: input }) => {
    const { sessionKey } = cardsListFilterSchema.parse(input);
    const result = await store.listCards(input.boardId, sessionKey);
    const since = input.sinceRevision;
    return isRecord(since) &&
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
      return redactCardResult(
        method === "create"
          ? store.create(prepared, undefined, request.sessionMutationCommitGuard)
          : store.captureSession(prepared),
      );
    });
  }
  register("workboard.cards.update", WRITE_SCOPE, async (request) => {
    const patch = await prepareWorkspaceInput(request, readPatch(request.params), "patch");
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
  cardMutation("comment", (id, input) =>
    store.addComment(id, { body: input.body }, undefined, "operator"),
  );
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
  register("workboard.boards.list", READ_SCOPE, () => store.listBoards());
  register("workboard.boards.upsert", WRITE_SCOPE, async (request) => {
    await resolveGatewayWorkspaceMutationAccess(request, request.params);
    return { board: await store.upsertBoard(request.params) };
  });
  const sessionsBoard = () => {
    if (!params.sessionsBoard) {
      throw new Error("Sessions board service is unavailable.");
    }
    return params.sessionsBoard;
  };
  register("workboard.sessionsBoard.read", READ_SCOPE, async (request) => {
    const result = await sessionsBoard().read(
      readStringParam(request.params, "boardId", { required: true }),
      sessionsBoardView(request.params),
      sessionsBoardCaller(request),
    );
    const since = request.params.sinceRevision;
    return isRecord(since) &&
      result.revision &&
      since.epoch === result.revision.epoch &&
      since.revision === result.revision.revision &&
      since.boardId === result.revision.boardId &&
      since.scope === result.revision.scope
      ? { unchanged: true, revision: result.revision }
      : result;
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
  register("workboard.sessionsBoard.move", WRITE_SCOPE, (request) =>
    sessionsBoard().move(
      readStringParam(request.params, "boardId", { required: true }),
      readStringParam(request.params, "sessionKey", { required: true }),
      readStringParam(request.params, "columnId", { required: true }),
      sessionsBoardCaller(request),
    ),
  );
  register("workboard.boards.archive", WRITE_SCOPE, async ({ params: input }) => ({
    board: await store.archiveBoard(input.id, input.archived),
  }));
  register("workboard.boards.delete", WRITE_SCOPE, ({ params: input }) =>
    store.deleteBoard(input.id),
  );
  register("workboard.cards.stats", READ_SCOPE, ({ params: input }) =>
    store.stats({ boardId: input.boardId }),
  );
  register("workboard.cards.trust", READ_SCOPE, ({ params: input }) =>
    store.trust({ boardId: input.boardId }),
  );
  register("workboard.overview", READ_SCOPE, ({ params: input }) => store.overview(input.boardId));
  register("workboard.transcriptViewer", READ_SCOPE, () => ({ port: transcriptViewerPort }));
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
  const requireCard = async (id: string) => {
    const card = await store.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return card;
  };
  // operator.read suffices for the node walk: live paths stay inside the dispatcher-owned
  // worktree.path and normalized screenshotDirs or docs/prototypes, and the node's
  // allowReadPaths bound them again. The walk also runs git on the node through
  // system.run, but with a fixed argv (checked commit id, normalized dirs after `--`)
  // in the worktree the ticket's agent already runs in, so a reader chooses nothing.
  const listArtifacts = async (kind: NodeTicketArtifactKind, input: Record<string, unknown>) => {
    const card = await requireCard(readId(input));
    const linked = (await Promise.all(relatedCardIds(card).map((id) => store.get(id)))).filter(
      (entry) => entry !== undefined,
    );
    return listNodeTicketArtifacts(api.runtime.gateway, card, kind, {
      live: input.live === true,
      linked,
    });
  };
  const readArtifact = async (kind: NodeTicketArtifactKind, input: Record<string, unknown>) => {
    const { round, live, path } = input;
    const source =
      live === true ? { live: true as const } : typeof round === "number" ? { round } : undefined;
    if (!source || typeof path !== "string" || !path) {
      throw new Error("path and either round or live: true are required.");
    }
    return readNodeTicketArtifact(
      api.runtime.gateway,
      await requireCard(readId(input)),
      kind,
      source,
      path,
    );
  };
  register("workboard.cards.screenshots.list", READ_SCOPE, ({ params: input }) =>
    listArtifacts("screenshot", input),
  );
  register("workboard.cards.changes.diff", READ_SCOPE, async ({ params: input }) => {
    const { round, path } = input;
    if (typeof round !== "number" || typeof path !== "string" || !path) {
      throw new Error("round and path are required.");
    }
    return readNodeTicketChangeDiff(await requireCard(readId(input)), round, path);
  });
  register("workboard.cards.screenshots.get", READ_SCOPE, async ({ params: input }) => {
    const { mimeType, bytes } = await readArtifact("screenshot", input);
    return { mimeType, contentBase64: bytes.toString("base64") };
  });
  register("workboard.cards.prototypes.list", READ_SCOPE, ({ params: input }) =>
    listArtifacts("prototype", input),
  );
  register("workboard.cards.prototypes.get", READ_SCOPE, async ({ params: input }) => ({
    html: (await readArtifact("prototype", input)).bytes.toString("utf8"),
  }));
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
