import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { redactCard, redactDispatchResult } from "./card-redaction.js";
import type { WorkboardHealthReader } from "./health.js";
import type { WorkboardAgentActor } from "./store-inputs.js";
import type { WorkboardStore } from "./store.js";
import {
  cardIdField,
  createWorkboardCardMutations,
  claimTokenField,
  strictObject,
  workspaceField,
} from "./tools-card-mutations.js";

const CardIdSchema = strictObject({
  id: cardIdField(),
  token: claimTokenField(),
});
const ScopedClaimTokenField = claimTokenField("Claim token for claimed cards.");
const OptionalNextStatusField = Type.Optional(
  Type.String({ description: "Optional next status." }),
);
const OptionalOperatorNoteField = Type.Optional(
  Type.String({ description: "Optional operator note." }),
);

export function createWorkboardOrchestrationTools(params: {
  store: WorkboardStore;
  ownerId: string;
  actor: WorkboardAgentActor;
  agentId?: string;
  health?: WorkboardHealthReader;
}): AnyAgentTool[] {
  const { store, ownerId, actor } = params;
  const { readScopedCardToolParams, scopedCardMutation, claimedCardMutation } =
    createWorkboardCardMutations(store, ownerId);
  const readHealth = () => {
    if (!params.health) {
      throw new Error("Workboard health is unavailable.");
    }
    return params.health.read({ agentId: params.agentId });
  };
  return [
    {
      name: "workboard_boards",
      label: "Workboard Boards",
      description: "List Workboard board namespaces with active, archived, and status counts.",
      parameters: strictObject({}),
      execute: async () => jsonResult(await store.listBoards()),
    },
    {
      name: "workboard_board_create",
      label: "Workboard Board Create",
      description:
        "Create or update a Workboard board with persisted SQLite metadata. Choose kind sessions on creation for columns with rules over Gateway-owned session facts; card tools do not apply to Sessions boards. Board kind cannot change after creation.",
      parameters: strictObject({
        id: Type.String({ description: "Board id." }),
        kind: Type.Optional(
          Type.Union([Type.Literal("cards"), Type.Literal("sessions")], {
            description: "Board kind, set only at creation. Default cards.",
          }),
        ),
        name: Type.Optional(Type.String({ description: "Display name." })),
        description: Type.Optional(Type.String({ description: "Board description." })),
        icon: Type.Optional(Type.String({ description: "Short icon or label." })),
        color: Type.Optional(Type.String({ description: "Display color token." })),
        automationJobId: Type.Optional(
          Type.String({
            description: "Owning automation job id.",
            minLength: 1,
            maxLength: 128,
          }),
        ),
        defaultWorkspace: workspaceField(),
        orchestration: Type.Optional(
          strictObject({
            autoDecompose: Type.Optional(
              Type.Boolean({ description: "Mark ready triage cards for decomposition." }),
            ),
            autoDecomposePerDispatch: Type.Optional(
              Type.Number({ description: "Maximum orchestration candidates per dispatch." }),
            ),
            defaultAssignee: Type.Optional(Type.String({ description: "Default assignee." })),
            orchestratorProfile: Type.Optional(
              Type.String({ description: "Orchestrator profile id." }),
            ),
          }),
        ),
      }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult({ board: await store.upsertBoard(asNonArrayRecord(rawParams)) }),
    },
    {
      name: "workboard_class_rung",
      label: "Workboard Class Rung",
      description:
        "Set one task class's rung on a board (a: the operator reviews, b: the agent decides, c: auto-merge with a sampled read), keeping every other class. A rung change stamps since to now; pass since (epoch ms) to restamp the trust window, for example to a promotion's day. Returns the board's classRungs.",
      parameters: strictObject({
        boardId: Type.String({ description: "Board id." }),
        class: Type.String({ description: "Task class without the class: prefix." }),
        rung: Type.Union([Type.Literal("a"), Type.Literal("b"), Type.Literal("c")]),
        since: Type.Optional(
          Type.Integer({ description: "Epoch ms the class's trust window starts.", minimum: 0 }),
        ),
        sampleEvery: Type.Optional(
          Type.Integer({
            description: "Rung c: a human reads 1 in this many accepted PRs. Default 3.",
            minimum: 1,
            maximum: 100,
          }),
        ),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        const { boardId, class: taskClass, ...entry } = record;
        return jsonResult({
          classRungs: await store.setClassRung(String(boardId), String(taskClass), entry),
        });
      },
    },
    {
      name: "workboard_board_archive",
      label: "Workboard Board Archive",
      description: "Archive or restore persisted Workboard board metadata.",
      parameters: strictObject({
        id: Type.String({ description: "Board id." }),
        archived: Type.Optional(Type.Boolean({ description: "Archive when true." })),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        return jsonResult({ board: await store.archiveBoard(record.id, record.archived) });
      },
    },
    {
      name: "workboard_board_delete",
      label: "Workboard Board Delete",
      description: "Delete an empty non-default Workboard board metadata record.",
      parameters: strictObject({ id: Type.String({ description: "Board id." }) }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult(await store.deleteBoard(asNonArrayRecord(rawParams).id)),
    },
    {
      name: "workboard_stats",
      label: "Workboard Stats",
      description:
        "Summarize Workboard counts by status and assignee for one board or all boards. With trust, also return the node ticket trust KPIs: per task class, and a weekly autonomy and lead time trend. With overview, also return the Factory overview: what waits on the operator, what is in flight, and what shipped this week. With mergeDigest, also return the rung c merges in the window, each with its revert command. With health, also return the factory's operational state: the boards' automation jobs with their last run and error, the paired state of the boards' target nodes, and whether the assignee agents' inference profiles are in a cooldown, disabled, or blocked window.",
      parameters: strictObject({
        boardId: Type.Optional(Type.String({ description: "Optional board id filter." })),
        trust: Type.Optional(
          Type.Boolean({ description: "Include node ticket trust KPIs (for retros and digests)." }),
        ),
        overview: Type.Optional(
          Type.Boolean({
            description:
              "Include the Factory overview: waiting on the operator, in flight, shipped this week.",
          }),
        ),
        mergeDigest: Type.Optional(
          Type.Boolean({
            description:
              "Include the rung c merge digest with revert commands (default window: last 24 h).",
          }),
        ),
        since: Type.Optional(
          Type.Number({
            description:
              "Epoch milliseconds starting the merge digest window; only used with mergeDigest.",
          }),
        ),
        health: Type.Optional(
          Type.Boolean({
            description:
              "Include the factory health: automation jobs, target node liveness, and inference profile windows.",
          }),
        ),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        const boardId = record.boardId;
        const stats = await store.stats({ boardId });
        return jsonResult({
          ...stats,
          ...(record.trust === true ? { trust: await store.trust({ boardId }) } : {}),
          ...(record.overview === true ? { overview: await store.overview(boardId) } : {}),
          ...(record.mergeDigest === true
            ? {
                mergeDigest: await store.mergeDigest({
                  boardId,
                  since: readNumberParam(record, "since", { nonNegativeInteger: true }),
                }),
              }
            : {}),
          ...(record.health === true ? { health: await readHealth() } : {}),
        });
      },
    },
    {
      name: "workboard_runs",
      label: "Workboard Runs",
      description: "List persisted Workboard run attempts for one card.",
      parameters: CardIdSchema,
      execute: async (_toolCallId, rawParams) => {
        const id = readStringParam(asNonArrayRecord(rawParams), "id", { required: true });
        const result = await store.runs(id);
        return jsonResult({ ...result, card: redactCard(result.card) });
      },
    },
    {
      name: "workboard_specify",
      label: "Workboard Specify",
      description:
        "Turn a rough triage/backlog Workboard card into a specified todo card after reasoning through the requirements.",
      parameters: strictObject({
        id: Type.String({ description: "Workboard card id." }),
        title: Type.Optional(Type.String({ description: "Clarified title." })),
        notes: Type.Optional(
          Type.String({ description: "Clarified notes or acceptance criteria (Markdown)." }),
        ),
        agentId: Type.Optional(Type.String({ description: "Assigned agent id." })),
        priority: Type.Optional(Type.String({ description: "low, normal, high, or urgent." })),
        labels: Type.Optional(Type.Array(Type.String(), { description: "Card labels." })),
        boardId: Type.Optional(Type.String({ description: "Board id." })),
        tenant: Type.Optional(Type.String({ description: "Tenant or routing namespace." })),
        skills: Type.Optional(Type.Array(Type.String(), { description: "Suggested skills." })),
        touches: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Repo-relative files or directories a node ticket will change. Its start waits while an open node ticket touching an overlapping path has not merged its PR.",
          }),
        ),
        workspace: workspaceField(),
        maxRuntimeSeconds: Type.Optional(Type.Number({ description: "Runtime budget." })),
        maxRetries: Type.Optional(Type.Number({ description: "Retry budget." })),
        summary: Type.Optional(
          Type.String({
            description:
              "1-3 plain sentences for the operator: what this is and why. Also posted as a comment.",
          }),
        ),
        token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
      }),
      execute: async (_toolCallId, rawParams) => {
        const { record, id, scope } = await readScopedCardToolParams(asNonArrayRecord(rawParams));
        return jsonResult({ card: redactCard(await store.specify(id, record, scope)) });
      },
    },
    {
      name: "workboard_decompose",
      label: "Workboard Decompose",
      description:
        "Fan out a Workboard card into linked child cards and optionally complete the parent orchestration card.",
      parameters: strictObject({
        id: Type.String({ description: "Parent Workboard card id." }),
        token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
        summary: Type.Optional(
          Type.String({
            description:
              "Decomposition summary (Markdown). Replaces the parent's operator summary, so keep it to 1-3 plain sentences.",
          }),
        ),
        completeParent: Type.Optional(
          Type.Boolean({
            description: "Complete the parent after child creation. Default true.",
          }),
        ),
        children: Type.Array(
          strictObject({
            title: Type.String({ description: "Child title." }),
            notes: Type.Optional(Type.String({ description: "Child notes (Markdown)." })),
            agentId: Type.Optional(Type.String({ description: "Assigned agent id." })),
            priority: Type.Optional(Type.String({ description: "low, normal, high, or urgent." })),
            labels: Type.Optional(Type.Array(Type.String())),
            boardId: Type.Optional(Type.String()),
            tenant: Type.Optional(Type.String()),
            skills: Type.Optional(Type.Array(Type.String())),
            touches: Type.Optional(Type.Array(Type.String())),
            workspace: workspaceField(),
            maxRuntimeSeconds: Type.Optional(Type.Number()),
            maxRetries: Type.Optional(Type.Number()),
            idempotencyKey: Type.Optional(Type.String()),
          }),
        ),
      }),
      execute: async (_toolCallId, rawParams) => {
        const { record, id, scope } = await readScopedCardToolParams(asNonArrayRecord(rawParams));
        const result = await store.decompose(id, record, scope, actor);
        return jsonResult({
          parent: redactCard(result.parent),
          children: result.children.map(redactCard),
        });
      },
    },
    {
      name: "workboard_notify_subscribe",
      label: "Workboard Notify Subscribe",
      description: "Persist a Workboard notification subscription in the plugin SQLite store.",
      parameters: strictObject({
        boardId: Type.Optional(Type.String({ description: "Board id. Default default." })),
        cardId: Type.Optional(Type.String({ description: "Card id." })),
        sessionKey: Type.Optional(Type.String({ description: "Session key." })),
        runId: Type.Optional(Type.String({ description: "Run id." })),
        target: Type.Optional(Type.String({ description: "Human-readable target." })),
        eventKinds: Type.Optional(
          Type.Array(Type.String(), { description: "completed, failed, stale." }),
        ),
      }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult({
          subscription: await store.subscribeNotifications(asNonArrayRecord(rawParams)),
        }),
    },
    {
      name: "workboard_notify_list",
      label: "Workboard Notify List",
      description: "List persisted Workboard notification subscriptions.",
      parameters: strictObject({
        boardId: Type.Optional(Type.String({ description: "Board id." })),
        cardId: Type.Optional(Type.String({ description: "Card id." })),
      }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult(await store.listNotificationSubscriptions(asNonArrayRecord(rawParams))),
    },
    {
      name: "workboard_notify_events",
      label: "Workboard Notify Events",
      description: "Read replay-safe Workboard notification events without advancing cursors.",
      parameters: strictObject({
        subscriptionId: Type.Optional(Type.String({ description: "Subscription id." })),
        boardId: Type.Optional(Type.String({ description: "Board id." })),
        cardId: Type.Optional(Type.String({ description: "Card id." })),
        limit: Type.Optional(Type.Number({ description: "Maximum events. Default 50." })),
      }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult(await store.notificationEvents(asNonArrayRecord(rawParams))),
    },
    {
      name: "workboard_notify_advance",
      label: "Workboard Notify Advance",
      description: "Read Workboard notification events and advance the subscription cursor.",
      parameters: strictObject({
        subscriptionId: Type.String({ description: "Subscription id." }),
        limit: Type.Optional(Type.Number({ description: "Maximum events. Default 50." })),
      }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult(await store.advanceNotificationEvents(asNonArrayRecord(rawParams))),
    },
    {
      name: "workboard_notify_unsubscribe",
      label: "Workboard Notify Unsubscribe",
      description: "Delete a persisted Workboard notification subscription.",
      parameters: strictObject({ id: Type.String({ description: "Subscription id." }) }),
      execute: async (_toolCallId, rawParams) => {
        const id = readStringParam(asNonArrayRecord(rawParams), "id", { required: true });
        return jsonResult(await store.deleteNotificationSubscription(id));
      },
    },
    {
      name: "workboard_promote",
      label: "Workboard Promote",
      description:
        "Promote a todo card into ready, optionally forcing past dependency or schedule holds. Unblock blocked cards first.",
      parameters: strictObject({
        id: cardIdField(),
        token: ScopedClaimTokenField,
        force: Type.Optional(Type.Boolean({ description: "Bypass dependency or schedule holds." })),
        reason: OptionalOperatorNoteField,
      }),
      execute: scopedCardMutation((id, record, scope) => store.promote(id, record, scope)),
    },
    {
      name: "workboard_reassign",
      label: "Workboard Reassign",
      description: "Change a card assignee and optionally reset failure state during recovery.",
      parameters: strictObject({
        id: cardIdField(),
        token: ScopedClaimTokenField,
        agentId: Type.Optional(Type.String({ description: "New assignee id." })),
        status: OptionalNextStatusField,
        resetFailures: Type.Optional(Type.Boolean({ description: "Reset failure count." })),
        reason: OptionalOperatorNoteField,
      }),
      execute: scopedCardMutation((id, record, scope) => store.reassign(id, record, scope, actor)),
    },
    {
      name: "workboard_reclaim",
      label: "Workboard Reclaim",
      description:
        "Release a stale claim and stop running attempts so another agent can pick it up.",
      parameters: strictObject({
        id: cardIdField(),
        token: ScopedClaimTokenField,
        status: OptionalNextStatusField,
        reason: OptionalOperatorNoteField,
      }),
      execute: scopedCardMutation((id, record, scope) => store.reclaim(id, record, scope, actor)),
    },
    {
      name: "workboard_dispatch",
      label: "Workboard Dispatch",
      description:
        "Advance persisted board state without launching workers: promote unblocked cards, reclaim expired claims, and block timed-out runs.",
      parameters: strictObject({
        boardId: Type.Optional(Type.String({ description: "Optional board id filter." })),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        const result = await store.dispatch({ boardId: record.boardId });
        return jsonResult(redactDispatchResult(result));
      },
    },
    {
      name: "workboard_worker_log",
      label: "Workboard Worker Log",
      description: "Append a persisted worker log entry to a Workboard card.",
      parameters: strictObject({
        id: cardIdField(),
        level: Type.Optional(Type.String({ description: "info, warning, or error." })),
        message: Type.String({ description: "Worker log message." }),
        sessionKey: Type.Optional(Type.String({ description: "Linked session key." })),
        runId: Type.Optional(Type.String({ description: "Linked run id." })),
        token: ScopedClaimTokenField,
      }),
      execute: scopedCardMutation((id, record, scope) => store.addWorkerLog(id, record, scope)),
    },
    {
      name: "workboard_protocol_violation",
      label: "Workboard Protocol Violation",
      description:
        "Block a card and record a worker protocol violation when work stops without complete/block.",
      parameters: strictObject({
        id: cardIdField(),
        detail: Type.Optional(Type.String({ description: "Violation detail." })),
        sessionKey: Type.Optional(Type.String({ description: "Linked session key." })),
        runId: Type.Optional(Type.String({ description: "Linked run id." })),
        token: ScopedClaimTokenField,
      }),
      execute: claimedCardMutation((id, record, scope) =>
        store.recordProtocolViolation(id, record, scope),
      ),
    },
  ];
}
