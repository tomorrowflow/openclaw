import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { asNonArrayRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods, WorkboardStore } from "./runtime-api.js";
import { createWorkboardAutomationNudgeService } from "./src/automation-nudge.js";
import { createWorkboardChangeEventService } from "./src/change-events.js";
import { registerWorkboardCommand } from "./src/command.js";
import { dispatchAndStartWorkboardCards } from "./src/dispatcher.js";
import { createWorkboardFeedService } from "./src/feed-service.js";
import { HELD_MERGE_NAMESPACE, type WorkboardCardFeed } from "./src/feed.js";
import { createWorkboardHealthService } from "./src/health.js";
import {
  readWorkboardLifecycleSessions,
  type WorkboardLifecycleSessionReader,
} from "./src/lifecycle-sessions.js";
import {
  createWorkboardLifecycleService,
  syncWorkboardSubagentEnded,
} from "./src/lifecycle-sync.js";
import { createNodeTicketHandoffs } from "./src/node-ticket-handoff.js";
import { createWorkboardSessionsBoardService } from "./src/sessions-board.js";
import { resolveWorkboardSqliteWorkerModuleUrl } from "./src/sqlite-store-paths.js";
import { registerWorkboardStoreLifecycle } from "./src/store-lifecycle.js";
import { createWorkboardTargetModelCheck } from "./src/target-model-policy.js";
import { strictObject } from "./src/tools-card-mutations.js";
import { createWorkboardTools } from "./src/tools.js";
import {
  guardWorkboardToolsForWorkspaceAccess,
  WORKBOARD_CARD_TOOL_NAMES,
  WORKBOARD_SESSIONS_BOARD_TOOL_NAMES,
} from "./src/workspace-access.js";

const boardIdField = Type.Optional(
  Type.String({
    description: "Board id. May be omitted only when exactly one Sessions board exists.",
  }),
);

function optionalChoices<const T extends string>(choices: readonly T[]) {
  return Type.Optional(Type.Array(Type.Union(choices.map((choice) => Type.Literal(choice)))));
}

const matchRuleSchema = strictObject({
  health: optionalChoices([
    "on-track",
    "grinding",
    "stuck",
    "waiting-on-user",
    "wrapping-up",
    "done",
    "failed",
  ]),
  run: optionalChoices(["active", "idle", "failed"]),
  pullRequest: optionalChoices(["none", "open", "draft", "merged", "closed"]),
  archived: Type.Optional(Type.Boolean()),
});

const columnSchema = strictObject({
  id: Type.String({
    minLength: 1,
    maxLength: 48,
    pattern: "^[a-z0-9][a-z0-9-]{0,47}$",
    description: "Stable column id. Keep this id when renaming the label.",
  }),
  label: Type.String({ minLength: 1, maxLength: 60 }),
  color: Type.Optional(
    Type.String({ description: "red, blue, green, yellow, purple, orange, pink, or cyan." }),
  ),
  description: Type.String({
    minLength: 1,
    maxLength: 400,
    description: "Description shown in the column tooltip.",
  }),
  match: Type.Optional(Type.Union([matchRuleSchema, Type.Array(matchRuleSchema, { minItems: 1 })])),
  fallback: Type.Optional(
    Type.Boolean({ description: "Exactly one column must be the unresolved-session fallback." }),
  ),
});

const sessionsBoardReadSchema = strictObject({ boardId: boardIdField });

const sessionsBoardUpdateSchema = strictObject({
  boardId: boardIdField,
  columns: Type.Optional(Type.Array(columnSchema, { minItems: 2, maxItems: 12 })),
  scope: Type.Optional(
    strictObject({
      agentIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      includeArchived: Type.Optional(Type.Boolean()),
      includeAutomation: Type.Optional(
        Type.Boolean({
          description: "Include automation (cron) and system sessions. Defaults to false.",
        }),
      ),
      includeHome: Type.Optional(
        Type.Boolean({
          description: "Include each agent's Home session. Defaults to false.",
        }),
      ),
      maxAgeHours: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    }),
  ),
});

const sessionsBoardMoveSchema = strictObject({
  boardId: boardIdField,
  sessionKey: Type.String({ description: "Exact session key from the board read." }),
  columnId: Type.String({
    description: "Destination column id from the board read.",
  }),
});

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerWorkboardCli } = await import("./src/cli.js");
        registerWorkboardCli({
          program,
          withStore: async (action) => {
            const cliStore = WorkboardStore.openSqlite(
              resolveWorkboardSqliteWorkerModuleUrl(api.runtimeSource),
            );
            try {
              return await action(cliStore);
            } finally {
              await cliStore.close();
            }
          },
        });
      },
      {
        descriptors: [
          {
            name: "workboard",
            description: "Manage Workboard cards and worker dispatch",
            hasSubcommands: true,
          },
        ],
      },
    );
    if (api.registrationMode === "cli-metadata") {
      return;
    }
    const store = WorkboardStore.openSqlite(
      resolveWorkboardSqliteWorkerModuleUrl(api.runtimeSource),
      { lazy: api.registrationMode === "tool-discovery" },
    );
    const nodeTickets = api.pluginConfig?.nodeTickets;
    if (isRecord(nodeTickets) && typeof nodeTickets.maxConcurrent === "number") {
      store.nodeTicketConcurrency = nodeTickets.maxConcurrent;
    }
    store.checkTargetModel = createWorkboardTargetModelCheck(api.runtime);
    const resourceServices: Array<{ stop(): void | Promise<void> }> = [];
    registerWorkboardStoreLifecycle(api, store, async () => {
      await Promise.all(resourceServices.map(async (service) => await service.stop()));
    });
    const changeEvents = createWorkboardChangeEventService(store);
    resourceServices.push(changeEvents);
    const automationNudge = createWorkboardAutomationNudgeService({
      store,
    });
    resourceServices.push(automationNudge);
    const sessionsBoard = createWorkboardSessionsBoardService({
      store,
      gateway: api.runtime.gateway,
    });
    resourceServices.push(sessionsBoard);
    const github = {
      token: (repo: string) =>
        getPreparedPluginSecretInput("workboard", `github.repos[${JSON.stringify(repo)}].token`)
          .value,
    };
    const readSessions: WorkboardLifecycleSessionReader = async (options) =>
      await readWorkboardLifecycleSessions(api.runtime.gateway, options);
    const nodeHandoffs = createNodeTicketHandoffs({
      store,
      runtime: api.runtime.gateway,
      // Secret resolution only reads the snapshot; its SDK type predates DeepReadonly.
      config: () => api.runtime.config.current() as OpenClawConfig,
      readSessions,
      github,
      // Rework rounds (D56) and queued starts take the same exact start as
      // workboard.cards.start; node tickets need no Gateway workspace, so no
      // caller authority applies.
      start: async (cardId, queue) =>
        await dispatchAndStartWorkboardCards({
          store,
          subagent: api.runtime.subagent,
          worktrees: api.runtime.worktrees,
          nodeTickets: api.runtime.gateway,
          options: { cardId, maxStarts: 1, queue },
        }),
      // The done report's agent_end nudge fires before the import reaches review.
      onReview: async (card) => await automationNudge.nudge({ cards: [card] }),
    });
    const lifecycleSync = createWorkboardLifecycleService({
      store,
      worktrees: api.runtime.worktrees,
      nodeHandoffs,
      readSessions,
      onMatched: automationNudge.nudge,
    });
    resourceServices.push(lifecycleSync);
    const feed = createWorkboardFeedService({
      store,
      // Oldest first out: an evicted card that is still active gets a new thread.
      openState: () =>
        api.runtime.state.openKeyedStoreV2<WorkboardCardFeed>({
          namespace: "board-feed",
          maxEntries: 5_000,
        }),
      channel: api.runtime.channel,
      subagent: api.runtime.subagent,
      // Identity and send reads only read the snapshot; their SDK types predate DeepReadonly.
      config: () => api.runtime.config.current() as OpenClawConfig,
      github,
      onOperatorComment: automationNudge.nudge,
    });
    resourceServices.push(feed);
    const health = createWorkboardHealthService({ store, runtime: api.runtime, feed });
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "workboard",
      label: "Workboard",
      placement: "route:workboard",
      icon: "kanban",
      group: "control",
      requiredScopes: ["operator.read"],
    });
    for (const [id, label, scope] of [
      ["board", "Workboard board", "operator.read"],
      ["card", "Workboard card", "operator.write"],
      ["mini", "Workboard summary", "operator.read"],
    ] as const) {
      api.session.controls.registerControlUiDescriptor({
        surface: "widget",
        id,
        label,
        requiredScopes: [scope],
      });
    }
    registerWorkboardGatewayMethods({
      api,
      store,
      sessionsBoard,
      readSessions,
      onOperatorComment: automationNudge.nudge,
      health,
    });
    registerWorkboardCommand({ api, store });
    for (const service of [
      changeEvents,
      automationNudge,
      sessionsBoard,
      lifecycleSync,
      feed,
      health,
    ]) {
      api.registerService(service);
    }
    api.on("inbound_claim", (event, context) => feed.claim(event, context));
    api.registerInteractiveHandler({
      channel: "discord",
      namespace: HELD_MERGE_NAMESPACE,
      handler: (context) => feed.press(context),
    });
    api.on("gateway_start", (_event, context) => lifecycleSync.onGatewayStart(context.abortSignal));
    api.on("gateway_stop", () => lifecycleSync.onGatewayStop());
    api.on("subagent_ended", (event) =>
      store.runOperation(async () => {
        await syncWorkboardSubagentEnded({
          store,
          worktrees: api.runtime.worktrees,
          event,
          onMatched: automationNudge.nudge,
        });
      }),
    );
    api.on("agent_end", async (event, context) => {
      await lifecycleSync.onAgentEnd(event, context);
      // Bundling and fetching outlast the agent_end hook budget; the sweep
      // resumes the handoff if the scheduled run dies with the Gateway.
      lifecycleSync.scheduleNodeHandoffs();
    });
    api.registerTool(
      (context) =>
        guardWorkboardToolsForWorkspaceAccess(
          createWorkboardTools({ context, store, health }),
          context,
          api.runtime.sandbox.resolveWorkspaceAuthority,
        ),
      {
        names: [...WORKBOARD_CARD_TOOL_NAMES],
        optional: true,
      },
    );
    // The docked Board agent needs these without a tools.allow entry.
    api.registerTool(
      {
        contextVersion: 2,
        create: (ctx) => {
          const caller = { assertCurrent: ctx.assertInvocationCurrent };
          const resolveBoardId = async (record: Record<string, unknown>): Promise<string> => {
            if (record.boardId !== undefined) {
              return readStringParam(record, "boardId", { required: true });
            }
            const boards = (await store.listBoards()).boards.filter(
              (board) => board.kind === "sessions",
            );
            const board = boards[0];
            if (boards.length === 1 && board) {
              return board.id;
            }
            throw new Error(
              boards.length === 0
                ? 'No Sessions board exists. Create one with workboard_board_create and kind: "sessions".'
                : "boardId is required when more than one Sessions board exists. Use workboard_boards to choose one.",
            );
          };
          const tools: AnyAgentTool[] = [
            {
              name: "workboard_sessions_board_read",
              label: "Sessions Board Read",
              description:
                "Read a Sessions board and its session placements. Columns match Gateway-owned session status, observer health, and pull-request facts in order; operator pins take precedence. Card tools do not apply to Sessions boards.",
              parameters: sessionsBoardReadSchema,
              execute: async (_toolCallId, rawParams) => {
                const record = asNonArrayRecord(rawParams);
                return jsonResult(
                  await sessionsBoard.read(await resolveBoardId(record), undefined, caller),
                );
              },
            },
            {
              name: "workboard_sessions_board_update",
              label: "Sessions Board Update",
              description:
                "Edit a Sessions board's columns, match rules, or scope. columns replaces the full ordered list; preserve ids when renaming labels. All fields in each rule must match; a match array accepts any rule, and the first matching column wins. Exactly one fallback is required. Card tools do not apply to Sessions boards.",
              parameters: sessionsBoardUpdateSchema,
              execute: async (_toolCallId, rawParams) => {
                const record = asNonArrayRecord(rawParams);
                const boardId = await resolveBoardId(record);
                const { boardId: _boardId, ...patch } = record;
                return jsonResult({ board: await sessionsBoard.update(boardId, patch, caller) });
              },
            },
            {
              name: "workboard_sessions_board_move",
              label: "Sessions Board Move",
              description:
                "Pin a session in a Sessions board column. The pin overrides match rules while the column exists. Card tools do not apply to Sessions boards.",
              parameters: sessionsBoardMoveSchema,
              execute: async (_toolCallId, rawParams) => {
                const record = asNonArrayRecord(rawParams);
                return jsonResult(
                  await sessionsBoard.move(
                    await resolveBoardId(record),
                    readStringParam(record, "sessionKey", { required: true }),
                    readStringParam(record, "columnId", { required: true }),
                    caller,
                  ),
                );
              },
            },
          ];
          for (const tool of tools) {
            const execute = tool.execute;
            tool.execute = (...args) => store.runOperation(() => execute(...args));
          }
          return tools;
        },
      },
      { names: [...WORKBOARD_SESSIONS_BOARD_TOOL_NAMES] },
    );
  },
});
