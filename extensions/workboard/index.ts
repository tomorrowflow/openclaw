import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { createWorkboardAutomationNudgeService } from "./src/automation-nudge.js";
import { createWorkboardChangeEventService } from "./src/change-events.js";
import { registerWorkboardCommand } from "./src/command.js";
import { dispatchAndStartWorkboardCards } from "./src/dispatcher.js";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
  syncWorkboardAgentEnded,
  syncWorkboardSubagentEnded,
  type WorkboardLifecycleSessionReader,
} from "./src/lifecycle-sync.js";
import { createNodeTicketHandoffs } from "./src/node-ticket-handoff.js";
import { createWorkboardSessionsBoardService } from "./src/sessions-board.js";
import { resolveWorkboardSqliteWorkerModuleUrl } from "./src/sqlite-store-paths.js";
import { registerWorkboardStoreLifecycle } from "./src/store-lifecycle.js";
import { WorkboardStore } from "./src/store.js";
import { createWorkboardTargetModelCheck } from "./src/target-model-policy.js";
import { createWorkboardSessionsBoardTools } from "./src/tools-sessions-board.js";
import { createWorkboardTools } from "./src/tools.js";
import {
  guardWorkboardToolsForWorkspaceAccess,
  WORKBOARD_CARD_TOOL_NAMES,
  WORKBOARD_SESSIONS_BOARD_TOOL_NAMES,
} from "./src/workspace-access.js";

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
              api.config,
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
      api.config,
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
    const readSessions: WorkboardLifecycleSessionReader = async (options) =>
      await readWorkboardLifecycleSessions(api.runtime.gateway, options);
    const nodeHandoffs = createNodeTicketHandoffs({
      store,
      runtime: api.runtime.gateway,
      readSessions,
      github: {
        token: (repo) =>
          getPreparedPluginSecretInput("workboard", `github.repos[${JSON.stringify(repo)}].token`)
            .value,
      },
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
    registerWorkboardGatewayMethods({ api, store, sessionsBoard, readSessions });
    registerWorkboardCommand({ api, store });
    for (const service of [changeEvents, automationNudge, sessionsBoard, lifecycleSync]) {
      api.registerService(service);
    }
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
    api.on("agent_end", (event, context) =>
      store.runOperation(async () => {
        await syncWorkboardAgentEnded({
          store,
          event,
          context,
          readSessions: lifecycleSync.readSessions,
          onMatched: automationNudge.nudge,
        });
        // Bundling and fetching outlast the agent_end hook budget; the sweep
        // resumes the handoff if the scheduled run dies with the Gateway.
        lifecycleSync.scheduleNodeHandoffs();
      }),
    );
    api.registerTool(
      (context) =>
        guardWorkboardToolsForWorkspaceAccess(
          createWorkboardTools({ context, store }),
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
        create: (ctx) =>
          createWorkboardSessionsBoardTools({
            store,
            sessionsBoard,
            caller: { assertCurrent: ctx.assertInvocationCurrent },
          }),
      },
      { names: [...WORKBOARD_SESSIONS_BOARD_TOOL_NAMES] },
    );
  },
});
