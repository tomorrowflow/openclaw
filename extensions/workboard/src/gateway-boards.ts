import { readStringParam } from "openclaw/plugin-sdk/core";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/secret-provider-alias";
import type { OpenClawPluginApi } from "../api.js";
import { normalizeBoardIdRequired } from "./store-normalizers.js";
import type { WorkboardStore } from "./store.js";

type Request = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];

/**
 * The board methods. `hasAdmin` reads the caller's operator.admin; `authorizeUpsert`
 * checks the workspace a board save names.
 */
export function registerWorkboardBoardMethods(options: {
  register: (
    method: string,
    scope: "operator.read" | "operator.write" | "operator.admin",
    handler: (request: Request) => unknown,
  ) => void;
  store: WorkboardStore;
  logger: OpenClawPluginApi["logger"];
  hasAdmin: (client: Request["client"]) => boolean;
  authorizeUpsert: (request: Request) => Promise<unknown>;
}): void {
  const { register, store, logger, hasAdmin, authorizeUpsert } = options;
  register("workboard.boards.list", "operator.read", () => store.listBoards());
  register("workboard.boards.upsert", "operator.write", async (request) => {
    await authorizeUpsert(request);
    return { board: await store.upsertBoard(request.params, { admin: hasAdmin(request.client) }) };
  });
  register("workboard.boards.archive", "operator.write", async ({ params: input }) => ({
    board: await store.archiveBoard(input.id, input.archived),
  }));
  register("workboard.boards.delete", "operator.write", ({ params: input }) =>
    store.deleteBoard(input.id),
  );
  // Resolves only a name the board lists, with the Gateway's secret providers. The value goes
  // to the caller alone; the log line names the board, the secret, and the connection.
  register("workboard.boards.revealSecret", "operator.admin", async (request) => {
    const boardId = normalizeBoardIdRequired(request.params.boardId);
    const name = readStringParam(request.params, "name", { required: true });
    const listed = (await store.boardOrchestration(boardId))?.secrets?.some(
      (secret) => secret.name === name,
    );
    if (!listed) {
      throw new Error(`Board ${boardId} does not list a secret named ${name}.`);
    }
    const config = request.context.getRuntimeConfig();
    const result = await resolveConfiguredSecretInputString({
      config,
      env: process.env,
      value: {
        source: "store",
        provider: resolveDefaultSecretProviderAlias(config, "store"),
        id: name,
      },
      path: `secrets.${name}`,
      unresolvedReasonStyle: "detailed",
    });
    if (result.value === undefined) {
      throw new Error(
        `Secret ${name} could not be resolved: ${result.unresolvedRefReason ?? "no value"} Store it with \`openclaw secrets store set ${name}\`.`,
      );
    }
    // The scope was checked at dispatch; a connection that closed during the awaited work gets nothing.
    const connId = request.client?.connId;
    if (connId && request.context.isConnectionActive?.(connId) === false) {
      throw new Error("The connection closed before the secret could be revealed.");
    }
    logger.info(
      `workboard board ${boardId} revealed secret ${name} to connection ${request.client?.connId ?? "in-process"}`,
    );
    return { value: result.value };
  });
}
