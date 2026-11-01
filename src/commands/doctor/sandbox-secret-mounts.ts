// Migrates the retired sandbox `docker.secretMounts` map (env NAME -> host file)
// to `docker.env` store SecretRefs. Doctor never creates store entries, never
// prints values, and leaves a scope untouched until every entry is ready.
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentEntriesWithSource } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  HealthCheckContext,
  HealthFinding,
  HealthRepairContext,
  HealthRepairResult,
} from "../../flows/health-checks.js";
import { ENV_SECRET_REF_ID_RE } from "../../secrets/ref-contract.js";

const SANDBOX_SECRET_MOUNTS_CHECK_ID = "core/doctor/sandbox-secret-mounts";

const REPAIR_HINT =
  "Store each value as a protected entry with `openclaw secrets store set NAME --kind secret`, then run `openclaw doctor --fix`. Doctor never creates or overwrites store entries.";

type DockerRecord = Record<string, unknown>;

type SecretMountScope = { path: string; docker: DockerRecord };

type StoreLookup =
  | { status: "available"; values: ReadonlyMap<string, string> }
  | { status: "unavailable" };

function readDocker(container: unknown): DockerRecord | undefined {
  return asRecord(asRecord(asRecord(container)?.sandbox)?.docker);
}

function listSecretMountScopes(config: OpenClawConfig): SecretMountScope[] {
  const scopes: SecretMountScope[] = [];
  const push = (path: string, docker: DockerRecord | undefined) => {
    if (docker && Object.hasOwn(docker, "secretMounts")) {
      scopes.push({ path, docker });
    }
  };
  push("agents.defaults.sandbox.docker", readDocker(config.agents?.defaults));
  for (const { entry, source } of listAgentEntriesWithSource(config)) {
    push(
      source.kind === "entries"
        ? `agents.entries.${source.key}.sandbox.docker`
        : `agents.list.${source.index}.sandbox.docker`,
      readDocker(entry),
    );
  }
  return scopes;
}

function readSecretMounts(docker: DockerRecord): Array<[string, unknown]> {
  return Object.entries(asRecord(docker.secretMounts) ?? {});
}

async function lookupStore(names: readonly string[], env: NodeJS.ProcessEnv): Promise<StoreLookup> {
  if (names.length === 0) {
    return { status: "available", values: new Map() };
  }
  try {
    const { readSelectedSecretStoreEntries } = await import("../../secrets/store/secret-store.js");
    const entries = await readSelectedSecretStoreEntries({ names, database: { env } });
    return { status: "available", values: new Map(entries.map((e) => [e.name, e.value])) };
  } catch {
    return { status: "unavailable" };
  }
}

async function readLegacyValue(filePath: string): Promise<string | undefined> {
  try {
    // The retired runtime forwarded the file content with trailing whitespace trimmed.
    return (await fs.readFile(filePath, "utf8")).trimEnd();
  } catch {
    return undefined;
  }
}

async function inspectScope(params: {
  scope: SecretMountScope;
  store: StoreLookup;
  provider: string;
}): Promise<{ problems: string[]; refs: Record<string, unknown> }> {
  const problems: string[] = [];
  const refs: Record<string, unknown> = {};
  const env = asRecord(params.scope.docker.env);
  for (const [name, filePath] of readSecretMounts(params.scope.docker)) {
    const ref = { source: "store", provider: params.provider, id: name };
    if (typeof filePath !== "string" || !ENV_SECRET_REF_ID_RE.test(name)) {
      problems.push(`${name}: not a valid secret store name or file path`);
      continue;
    }
    if (env && Object.hasOwn(env, name) && !isDeepStrictEqual(env[name], ref)) {
      problems.push(`${name}: ${params.scope.path}.env.${name} is already set to another value`);
      continue;
    }
    if (params.store.status === "unavailable") {
      problems.push(`${name}: secret store is unavailable`);
      continue;
    }
    const stored = params.store.values.get(name);
    if (stored === undefined) {
      problems.push(
        `${name}: no protected store entry; run \`openclaw secrets store set ${name} --kind secret --value-file - < ${JSON.stringify(filePath)}\``,
      );
      continue;
    }
    const legacy = await readLegacyValue(filePath);
    if (legacy !== undefined && legacy !== stored) {
      problems.push(`${name}: store entry differs from ${filePath}`);
      continue;
    }
    refs[name] = ref;
  }
  return { problems, refs };
}

/** Plans the migration on a copy of the config; returns no findings when nothing is retired. */
export async function inspectSandboxSecretMounts(
  ctx: Pick<HealthCheckContext, "cfg" | "env">,
): Promise<{ config: OpenClawConfig; changes: string[]; findings: HealthFinding[] }> {
  const changes: string[] = [];
  const findings: HealthFinding[] = [];
  if (listSecretMountScopes(ctx.cfg).length === 0) {
    return { config: ctx.cfg, changes, findings };
  }
  const config = structuredClone(ctx.cfg);
  const scopes = listSecretMountScopes(config);
  const names = [
    ...new Set(
      scopes.flatMap(({ docker }) =>
        readSecretMounts(docker)
          .map(([name]) => name)
          .filter((name) => ENV_SECRET_REF_ID_RE.test(name)),
      ),
    ),
  ];
  const store = await lookupStore(names, ctx.env ?? process.env);
  const provider = ctx.cfg.secrets?.defaults?.store ?? "default";
  for (const scope of scopes) {
    const { problems, refs } = await inspectScope({ scope, store, provider });
    if (problems.length === 0) {
      scope.docker.env = { ...asRecord(scope.docker.env), ...refs };
      delete scope.docker.secretMounts;
      changes.push(
        `Moved ${scope.path}.secretMounts to ${scope.path}.env store SecretRefs (${Object.keys(refs).join(", ") || "empty"}).`,
      );
    }
    findings.push({
      checkId: SANDBOX_SECRET_MOUNTS_CHECK_ID,
      severity: "warning",
      path: `${scope.path}.secretMounts`,
      message:
        problems.length === 0
          ? `${scope.path}.secretMounts is retired; protected store entries are ready to migrate to docker.env SecretRefs.`
          : `${scope.path}.secretMounts is retired and needs repair (${problems.join("; ")}).`,
      fixHint: REPAIR_HINT,
    });
  }
  return { config, changes, findings };
}

export async function repairSandboxSecretMounts(
  ctx: HealthRepairContext,
): Promise<HealthRepairResult> {
  const result = await inspectSandboxSecretMounts(ctx);
  if (ctx.dryRun) {
    return {
      status: "skipped",
      changes: [],
      reason: "Run openclaw doctor --fix to persist the sandbox secretMounts migration.",
    };
  }
  const remaining = new Set(
    listSecretMountScopes(result.config).map(({ path }) => `${path}.secretMounts`),
  );
  return {
    status: result.changes.length ? "repaired" : "skipped",
    config: result.changes.length ? result.config : ctx.cfg,
    changes: result.changes,
    warnings: result.findings
      .filter(({ path }) => path !== undefined && remaining.has(path))
      .map(({ message }) => `${message} ${REPAIR_HINT}`),
  };
}
