import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { writeSecretStoreEntries } from "../../secrets/store/secret-store.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { inspectSandboxSecretMounts, repairSandboxSecretMounts } from "./sandbox-secret-mounts.js";

let state: OpenClawTestState;
let files: Record<"ready" | "mismatch" | "unreadable", string>;

beforeAll(async () => {
  state = await createOpenClawTestState({ prefix: "sandbox-secret-mounts-", applyEnv: true });
  await writeSecretStoreEntries({
    scope: { kind: "team" },
    updatedBy: "fixture",
    entries: [
      { name: "GH_TOKEN", kind: "secret", value: "synthetic-gh-token" },
      { name: "NPM_TOKEN", kind: "secret", value: "synthetic-npm-token" },
      { name: "READABLE_TOKEN", kind: "env", value: "synthetic-readable" },
    ],
  });
  files = {
    ready: await state.writeText("secrets/gh-token", "synthetic-gh-token\n"),
    mismatch: await state.writeText("secrets/npm-token", "rotated-npm-token\n"),
    unreadable: state.path("secrets/missing-file"),
  };
});

afterAll(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

function repairContext(cfg: OpenClawConfig, dryRun = false) {
  return {
    mode: "fix" as const,
    cfg,
    env: state.env,
    dryRun,
    runtime: { log: () => {}, error: () => {}, exit: () => {} } as never,
  };
}

describe("sandbox secretMounts Doctor migration", () => {
  it("moves a ready scope to store SecretRefs and leaves blocked scopes untouched", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            docker: {
              env: { LANG: "C.UTF-8" },
              secretMounts: { GH_TOKEN: files.ready },
            },
          },
        },
        entries: {
          missing: {
            sandbox: {
              docker: { secretMounts: { GH_TOKEN: files.ready, PIP_TOKEN: files.unreadable } },
            },
          },
          mismatch: { sandbox: { docker: { secretMounts: { NPM_TOKEN: files.mismatch } } } },
          conflict: {
            sandbox: {
              docker: {
                env: { GH_TOKEN: "inline-gh-token" },
                secretMounts: { GH_TOKEN: files.ready },
              },
            },
          },
          envkind: { sandbox: { docker: { secretMounts: { READABLE_TOKEN: files.ready } } } },
        },
      },
    };
    const before = structuredClone(cfg);

    const result = await repairSandboxSecretMounts(repairContext(cfg));

    expect(cfg).toEqual(before);
    expect(result.status).toBe("repaired");
    expect(result.config?.agents?.defaults?.sandbox?.docker).toEqual({
      env: {
        LANG: "C.UTF-8",
        GH_TOKEN: { source: "store", provider: "default", id: "GH_TOKEN" },
      },
    });
    const entries = result.config?.agents?.entries;
    expect(entries?.missing?.sandbox?.docker).toEqual(
      before.agents?.entries?.missing?.sandbox?.docker,
    );
    expect(entries?.mismatch?.sandbox?.docker).toEqual(
      before.agents?.entries?.mismatch?.sandbox?.docker,
    );
    expect(entries?.conflict?.sandbox?.docker).toEqual(
      before.agents?.entries?.conflict?.sandbox?.docker,
    );
    expect(entries?.envkind?.sandbox?.docker).toEqual(
      before.agents?.entries?.envkind?.sandbox?.docker,
    );

    const warnings = result.warnings?.join("\n") ?? "";
    expect(warnings).toContain(
      `PIP_TOKEN: no protected store entry; run \`openclaw secrets store set PIP_TOKEN --kind secret --value-file - < ${JSON.stringify(files.unreadable)}\``,
    );
    expect(warnings).toContain(`NPM_TOKEN: store entry differs from ${files.mismatch}`);
    expect(warnings).toContain(
      "GH_TOKEN: agents.entries.conflict.sandbox.docker.env.GH_TOKEN is already set to another value",
    );
    expect(warnings).toContain("READABLE_TOKEN: no protected store entry");
    expect(warnings).not.toMatch(/synthetic-|rotated-npm-token|inline-gh-token/);
    await expect(fs.readFile(files.ready, "utf8")).resolves.toBe("synthetic-gh-token\n");
  });

  it("reports without writing on dry runs and stays silent without retired keys", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { sandbox: { docker: { secretMounts: { GH_TOKEN: files.ready } } } } },
    };

    expect(await repairSandboxSecretMounts(repairContext(cfg, true))).toMatchObject({
      status: "skipped",
      changes: [],
    });
    expect(cfg.agents?.defaults?.sandbox?.docker?.secretMounts).toEqual({ GH_TOKEN: files.ready });
    expect(
      (await inspectSandboxSecretMounts({ cfg: { agents: { entries: { main: {} } } } })).findings,
    ).toEqual([]);
  });
});
