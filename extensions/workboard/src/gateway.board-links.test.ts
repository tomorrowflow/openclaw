import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseAsync,
  writeSecretStoreEntryForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const stateDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  for (const dir of stateDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Points the Gateway's state at a fresh directory and returns a writer for its secrets store. */
function isolatedSecretStore() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "workboard-board-links-state-"));
  stateDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return (name: string, value: string) =>
    writeSecretStoreEntryForTest({
      scope: { kind: "team" },
      name,
      value,
      kind: "secret",
      updatedBy: "workboard-board-links-test",
      database: { env: { OPENCLAW_STATE_DIR: stateDir } },
    });
}

const links = [{ label: "Test", url: "https://test.example.ts.net:8780", group: "Test" }];
const secrets = [{ label: "Test token", name: "LIN_TEST_TOKEN", group: "Test" }];

function setup(options: { connectionActive?: boolean } = {}) {
  const store = createWorkboardSqliteTestStore();
  const info = vi.fn();
  const { api, methods } = createGatewayMethodCapture(undefined, { info });
  registerWorkboardGatewayMethods({ api, store });
  const call = async (method: string, params: Record<string, unknown>, scope: string) => {
    const respond = vi.fn();
    await methods.get(method)!.handler({
      params,
      client: { connId: "conn-1", connect: { scopes: [scope] } },
      context: {
        getRuntimeConfig: () => ({}),
        isConnectionActive: () => options.connectionActive ?? true,
      },
      respond,
    } as never);
    const [ok, data, error] = respond.mock.calls[0] as [boolean, any, { message?: string }?];
    return { ok, data, message: error?.message };
  };
  const board = async () => (await store.listBoards()).boards.find(({ id }) => id === "lindra");
  return { call, board, info, methods };
}

describe("board links and revealable secrets", () => {
  it("lets a writer change links, refuses a non-http URL, and removes both lists with null", async () => {
    const { call, board } = setup();
    const upsert = (orchestration: Record<string, unknown>, scope = "operator.write") =>
      call("workboard.boards.upsert", { id: "lindra", orchestration }, scope);

    expect((await upsert({ links })).ok).toBe(true);
    expect((await board())?.orchestration?.links).toEqual(links);

    const refused = await upsert({ links: [{ label: "Bad", url: "javascript:alert(1)" }] });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("http or https");
    expect((await board())?.orchestration?.links).toEqual(links);

    expect((await upsert({ key: "LIN", secrets }, "operator.admin")).ok).toBe(true);
    expect((await upsert({ links: null, secrets: null }, "operator.admin")).ok).toBe(true);
    expect((await board())?.orchestration).toEqual({ key: "LIN" });
  });

  it("needs operator.admin to change the secrets list and rejects a bad or repeated name", async () => {
    const { call, board } = setup();
    const upsert = (value: unknown, scope: string) =>
      call(
        "workboard.boards.upsert",
        { id: "lindra", orchestration: { key: "LIN", secrets: value } },
        scope,
      );

    const refused = await upsert(secrets, "operator.write");
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("needs operator.admin");
    expect((await board())?.orchestration?.secrets).toBeUndefined();

    expect((await upsert([{ label: "x", name: "not valid!" }], "operator.admin")).ok).toBe(false);
    expect((await upsert([...secrets, ...secrets], "operator.admin")).ok).toBe(false);
    expect((await upsert(secrets, "operator.admin")).ok).toBe(true);
  });

  it("lists only secrets named for the board key, through a key change too", async () => {
    const { call, board } = setup();
    const upsert = (orchestration: Record<string, unknown>) =>
      call("workboard.boards.upsert", { id: "lindra", orchestration }, "operator.admin");

    const keyless = await upsert({ secrets });
    expect(keyless.message).toContain("needs a board key");
    const foreign = await upsert({ key: "LIN", secrets: [{ label: "GitHub", name: "GH_TOKEN" }] });
    expect(foreign.message).toContain("must start with LIN_");

    expect((await upsert({ key: "LIN", secrets })).ok).toBe(true);
    const rekeyed = await upsert({ key: "GH" });
    expect(rekeyed.message).toContain("must start with GH_");
    expect((await board())?.orchestration).toEqual({ key: "LIN", secrets });
  });

  it("reveals only a name the board lists, logs without the value, and names the fix when unresolved", async () => {
    const { call, info, methods } = setup();
    expect(methods.get("workboard.boards.revealSecret")?.opts).toMatchObject({
      scope: "operator.admin",
    });
    await call(
      "workboard.boards.upsert",
      { id: "lindra", orchestration: { key: "LIN", secrets } },
      "operator.admin",
    );
    const reveal = (name: string) =>
      call("workboard.boards.revealSecret", { boardId: "lindra", name }, "operator.admin");

    const store = isolatedSecretStore();
    await store("LIN_TEST_TOKEN", "s3cret");
    await store("OTHER_TOKEN", "other");
    const revealed = await reveal("LIN_TEST_TOKEN");
    expect(revealed).toMatchObject({ ok: true, data: { value: "s3cret" } });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain("LIN_TEST_TOKEN");
    expect(info.mock.calls[0]?.[0]).toContain("conn-1");
    expect(info.mock.calls[0]?.[0]).not.toContain("s3cret");

    const unlisted = await reveal("OTHER_TOKEN");
    expect(unlisted.ok).toBe(false);
    expect(JSON.stringify(unlisted)).not.toContain("other");

    expect(info).toHaveBeenCalledTimes(1);

    await call(
      "workboard.boards.upsert",
      { id: "lindra", orchestration: { secrets: [{ label: "Gone", name: "LIN_MISSING_TOKEN" }] } },
      "operator.admin",
    );
    const missing = await reveal("LIN_MISSING_TOKEN");
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("openclaw secrets store set LIN_MISSING_TOKEN");
  });

  it("gives nothing to a connection that closed during the lookup", async () => {
    const { call } = setup({ connectionActive: false });
    await call(
      "workboard.boards.upsert",
      { id: "lindra", orchestration: { key: "LIN", secrets } },
      "operator.admin",
    );
    await isolatedSecretStore()("LIN_TEST_TOKEN", "s3cret");
    const revealed = await call(
      "workboard.boards.revealSecret",
      { boardId: "lindra", name: "LIN_TEST_TOKEN" },
      "operator.admin",
    );
    expect(revealed.ok).toBe(false);
    expect(JSON.stringify(revealed)).not.toContain("s3cret");
  });
});
