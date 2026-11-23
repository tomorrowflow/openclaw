import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const resolveSecret = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputString: resolveSecret,
}));

const links = [{ label: "Test", url: "https://test.example.ts.net:8780", group: "Test" }];
const secrets = [{ label: "Test token", name: "LINDRA_TEST_TOKEN", group: "Test" }];

function setup() {
  const store = createWorkboardSqliteTestStore();
  const { api, methods } = createGatewayMethodCapture();
  const info = vi.fn();
  (api as unknown as { logger: { info: typeof info } }).logger = { info };
  registerWorkboardGatewayMethods({ api, store });
  const call = async (method: string, params: Record<string, unknown>, scope: string) => {
    const respond = vi.fn();
    await methods.get(method)!.handler({
      params,
      client: { connId: "conn-1", connect: { scopes: [scope] } },
      context: { getRuntimeConfig: () => ({}) },
      respond,
    } as never);
    const [ok, data, error] = respond.mock.calls[0] as [boolean, any, { message?: string }?];
    return { ok, data, message: error?.message };
  };
  const board = async () => (await store.listBoards()).boards.find(({ id }) => id === "lindra");
  return { call, board, info, methods };
}

describe("board links and revealable secrets", () => {
  beforeEach(() => resolveSecret.mockReset());

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

    expect((await upsert({ secrets }, "operator.admin")).ok).toBe(true);
    expect((await upsert({ links: null, secrets: null }, "operator.admin")).ok).toBe(true);
    expect((await board())?.orchestration).toBeUndefined();
  });

  it("needs operator.admin to change the secrets list and rejects a bad or repeated name", async () => {
    const { call, board } = setup();
    const upsert = (value: unknown, scope: string) =>
      call("workboard.boards.upsert", { id: "lindra", orchestration: { secrets: value } }, scope);

    const refused = await upsert(secrets, "operator.write");
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("needs operator.admin");
    expect((await board())?.orchestration?.secrets).toBeUndefined();

    expect((await upsert([{ label: "x", name: "not valid!" }], "operator.admin")).ok).toBe(false);
    expect((await upsert([...secrets, ...secrets], "operator.admin")).ok).toBe(false);
    expect((await upsert(secrets, "operator.admin")).ok).toBe(true);
  });

  it("reveals only a name the board lists, logs without the value, and names the fix when unresolved", async () => {
    const { call, info, methods } = setup();
    expect(methods.get("workboard.boards.revealSecret")?.opts).toMatchObject({
      scope: "operator.admin",
    });
    await call(
      "workboard.boards.upsert",
      { id: "lindra", orchestration: { secrets } },
      "operator.admin",
    );
    const reveal = (name: string, scope = "operator.admin") =>
      call("workboard.boards.revealSecret", { boardId: "lindra", name }, scope);

    resolveSecret.mockResolvedValue({ value: "s3cret" });
    const revealed = await reveal("LINDRA_TEST_TOKEN");
    expect(revealed).toMatchObject({ ok: true, data: { value: "s3cret" } });
    expect(resolveSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        value: { source: "store", provider: "default", id: "LINDRA_TEST_TOKEN" },
      }),
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain("LINDRA_TEST_TOKEN");
    expect(info.mock.calls[0]?.[0]).toContain("conn-1");
    expect(info.mock.calls[0]?.[0]).not.toContain("s3cret");

    resolveSecret.mockClear();
    const unlisted = await reveal("OTHER_TOKEN");
    expect(unlisted.ok).toBe(false);
    expect(resolveSecret).not.toHaveBeenCalled();

    const writer = await reveal("LINDRA_TEST_TOKEN", "operator.write");
    expect(writer.ok).toBe(false);
    expect(resolveSecret).not.toHaveBeenCalled();

    resolveSecret.mockResolvedValue({ value: undefined, unresolvedRefReason: "not found." });
    const missing = await reveal("LINDRA_TEST_TOKEN");
    expect(missing.message).toContain("openclaw secrets store set LINDRA_TEST_TOKEN");
  });
});
