import path from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import type { WebSocket } from "ws";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { gitHubPublicApi } from "./github-public-api.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import type { GatewayServer } from "./server-public.js";
import {
  BROWSER_ORIGIN,
  configureGatewayAuth,
  connectIdentity,
  deviceIdentityPath,
  responseAuth,
} from "./server.auth.identity-scopes.test-support.js";
import {
  connectReq,
  installGatewayTestHooks,
  openTailscaleWs,
  rpcReq,
  testTailscaleWhois,
  waitForWsClose,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const GITHUB_RATE_LIMITED_ERROR = {
  code: "UNAVAILABLE",
  message: expect.stringContaining("GitHub is rate limiting profile verification"),
  retryAfterMs: expect.toSatisfy((ms: number) => ms > 60_000),
};

/** Stubs only api.github.com user lookups; `quotaExhausted` switches to GitHub's real 403. */
function stubGitHubUserLookups(users: Record<string, { id: number; login: string }>) {
  // Load the source plugin before opening sockets and starting handshake deadlines.
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
  const githubApiOrigin = gitHubPublicApi.GITHUB_API_ORIGIN;
  const realFetch = globalThis.fetch;
  const github = { requests: [] as string[], quotaExhausted: false };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== githubApiOrigin) {
      return await realFetch(input, init);
    }
    github.requests.push(url.pathname);
    if (github.quotaExhausted) {
      return new Response("{}", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil(Date.now() / 1_000) + 3_600),
        },
      });
    }
    const user = users[url.pathname.replace(/^\/users\//, "")];
    return user ? Response.json(user) : Response.json({}, { status: 404 });
  });
  onTestFinished(() => fetchSpy.mockRestore());
  return github;
}

/** Connects as `<login>@github` through the managed Tailscale Serve listener. */
function gitHubTailscalePeople(
  server: Pick<GatewayServer, "getTailscaleIngressEndpoint">,
  scopes = ["operator.read"],
) {
  const endpoint = server.getTailscaleIngressEndpoint();
  if (!endpoint) {
    throw new Error("expected managed Tailscale listener");
  }
  return async (
    login: string,
    run: (ws: WebSocket, connected: Awaited<ReturnType<typeof connectReq>>) => Promise<void>,
  ) => {
    testTailscaleWhois.value = { login, name: login };
    const ws = await openTailscaleWs(endpoint, {
      origin: BROWSER_ORIGIN,
      "tailscale-user-login": login,
    });
    try {
      await run(
        ws,
        await connectIdentity(ws, {
          skipDefaultAuth: true,
          scopes,
          deviceIdentityPath: deviceIdentityPath(`github-${login}`),
        }),
      );
    } finally {
      ws.close();
    }
  };
}

describe("gateway identity scope grants for GitHub people", () => {
  test("keeps a verified GitHub person signed in while anonymous GitHub quota is exhausted", async () => {
    await configureGatewayAuth(
      { mode: "token", token: "secret", allowTailscale: true },
      { tailscaleMode: "serve" },
    );
    const github = stubGitHubUserLookups({ ada: { id: 583231, login: "ada" } });

    await withGatewayServer(async ({ server }) => {
      const withPerson = gitHubTailscalePeople(server);
      let profileId: string | undefined;
      await withPerson("ada@github", async (ws, connected) => {
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        const self = await rpcReq<UsersSelfResult>(ws, "users.self");
        expect(self.ok, JSON.stringify(self.error)).toBe(true);
        profileId = self.payload?.profile.id;
      });

      github.quotaExhausted = true;
      await withPerson("ada@github", async (ws, connected) => {
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        const self = await rpcReq<UsersSelfResult>(ws, "users.self");
        expect(self.payload?.profile.id, JSON.stringify(self.error)).toBe(profileId);
        const sessions = await rpcReq(ws, "sessions.list");
        expect(sessions.ok, JSON.stringify(sessions.error)).toBe(true);
      });
      await withPerson("eve@github", async (ws, connected) => {
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        for (const method of ["users.self", "sessions.list"]) {
          const response = await rpcReq(ws, method);
          expect(response.error, method).toMatchObject(GITHUB_RATE_LIMITED_ERROR);
        }
      });
    });
    expect(github.requests).toEqual(["/users/ada", "/users/ada"]);
  });

  test("refuses a reassigned GitHub login's former profile and role while GitHub is rate limiting", async () => {
    await configureGatewayAuth(
      { mode: "token", token: "secret", allowTailscale: true },
      {
        tailscaleMode: "serve",
        roles: {
          default: "guest",
          definitions: {
            guest: { sessions: { others: "none" }, agents: [], scopes: ["operator.read"] },
            staff: {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
          },
        },
      },
    );
    const users = {
      ada: { id: 583231, login: "ada" },
      grace: { id: 1001, login: "grace" },
    } as Record<string, { id: number; login: string }>;
    const github = stubGitHubUserLookups(users);
    const scopes = ["operator.read", "operator.write"];
    const staffProfileIds: string[] = [];

    await withGatewayServer(async ({ server }) => {
      const withPerson = gitHubTailscalePeople(server, scopes);
      const profileOf = async (login: string) => {
        let profileId: string | undefined;
        await withPerson(login, async (ws, connected) => {
          expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
          const self = await rpcReq<UsersSelfResult>(ws, "users.self");
          expect(self.ok, JSON.stringify(self.error)).toBe(true);
          profileId = self.payload?.profile.id;
        });
        if (!profileId) {
          throw new Error(`expected a verified profile for ${login}`);
        }
        return profileId;
      };
      try {
        const ada = await profileOf("ada@github");
        const grace = await profileOf("grace@github");
        for (const profileId of [ada, grace]) {
          setUserProfileRole(profileId, "staff");
          staffProfileIds.push(profileId);
        }

        // ada renames to ada-lovelace, so the profile no longer holds the `ada` login.
        users["ada-lovelace"] = { id: 583231, login: "ada-lovelace" };
        expect(await profileOf("ada-lovelace@github")).toBe(ada);
        // The `grace` login moves to a different GitHub account id.
        users.grace = { id: 2002, login: "grace" };
        const graceSuccessor = await profileOf("grace@github");
        expect(graceSuccessor).not.toBe(grace);

        github.quotaExhausted = true;
        await withPerson("ada-lovelace@github", async (ws, connected) => {
          expect(responseAuth(connected)?.scopes).toEqual(scopes);
          const self = await rpcReq<UsersSelfResult>(ws, "users.self");
          expect(self.payload?.profile.id, JSON.stringify(self.error)).toBe(ada);
        });
        // The renamed-away login is refused at admission, before hello, sessions, or role methods.
        await withPerson("ada@github", async (ws, connected) => {
          expect(connected).toMatchObject({ ok: false, error: GITHUB_RATE_LIMITED_ERROR });
          expect(await waitForWsClose(ws, 1_000)).toBe(true);
        });
        // The reassigned login reaches only its new account's guest profile, never the former one.
        await withPerson("grace@github", async (ws, connected) => {
          expect(responseAuth(connected)?.scopes).toEqual(["operator.read"]);
          const self = await rpcReq<UsersSelfResult>(ws, "users.self");
          expect(self.payload?.profile.id, JSON.stringify(self.error)).toBe(graceSuccessor);
          expect(await rpcReq(ws, "sessions.patch", { key: "agent:main:x", label: "x" })).toEqual(
            expect.objectContaining({
              ok: false,
              error: expect.objectContaining({
                message: expect.stringContaining("operator.write"),
              }),
            }),
          );
        });
      } finally {
        for (const profileId of staffProfileIds) {
          invalidateOperatorRolePolicy(profileId);
        }
      }
    });
    expect(github.requests).toEqual([
      "/users/ada",
      "/users/grace",
      "/users/ada-lovelace",
      "/users/grace",
      "/users/ada-lovelace",
    ]);
  });
});
