/**
 * Sandbox skill runtime input selection.
 *
 * Sandboxed runs must build prompt-facing skill entries from readable in-sandbox
 * copies instead of reusing host-path snapshots.
 */
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
} from "../../skills/loading/workspace.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "../../skills/runtime/env-overrides.js";
import type { SkillEligibilityContext, SkillSnapshot } from "../../skills/types.js";
import type { SkillEntry } from "../../skills/types.js";
import type { SandboxContext } from "../sandbox/types.js";

const MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS = [".openclaw", "sandbox-skills"] as const;
type SandboxSkillRuntimeContext = Pick<SandboxContext, "enabled"> &
  Partial<
    Pick<
      SandboxContext,
      "skillsEligibility" | "skillsWorkspaceDir" | "containerWorkdir" | "workspaceAccess"
    >
  >;

function containerJoin(root: string, ...parts: string[]): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const suffix = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot;
}

function pathEscapesRoot(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

function mapPathFromWorkspaceToContainer(params: {
  filePath: string | undefined;
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): string | undefined {
  if (!params.filePath || !path.isAbsolute(params.filePath)) {
    return params.filePath;
  }
  const relativePath = path.relative(
    path.resolve(params.sourceWorkspaceDir),
    path.resolve(params.filePath),
  );
  if (pathEscapesRoot(relativePath)) {
    return params.filePath;
  }
  if (!relativePath) {
    return params.targetWorkspaceDir.replace(/\\/g, "/");
  }
  return containerJoin(params.targetWorkspaceDir, ...relativePath.split(path.sep).filter(Boolean));
}

export function mapSandboxSkillEntriesForPrompt(params: {
  entries?: SkillEntry[];
  skillsWorkspaceDir: string;
  skillsPromptWorkspaceDir: string;
}): SkillEntry[] | undefined {
  if (!params.entries || params.skillsWorkspaceDir === params.skillsPromptWorkspaceDir) {
    return params.entries;
  }
  return params.entries.map((entry) => {
    const filePath =
      mapPathFromWorkspaceToContainer({
        filePath: entry.skill.filePath,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.skill.filePath;
    const baseDir =
      mapPathFromWorkspaceToContainer({
        filePath: entry.skill.baseDir,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.skill.baseDir;
    const sourceInfoPath =
      mapPathFromWorkspaceToContainer({
        filePath: entry.skill.sourceInfo.path,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.skill.sourceInfo.path;
    const sourceInfoBaseDir = mapPathFromWorkspaceToContainer({
      filePath: entry.skill.sourceInfo.baseDir,
      sourceWorkspaceDir: params.skillsWorkspaceDir,
      targetWorkspaceDir: params.skillsPromptWorkspaceDir,
    });
    return {
      ...entry,
      skill: {
        ...entry.skill,
        filePath,
        baseDir,
        sourceInfo: {
          ...entry.skill.sourceInfo,
          path: sourceInfoPath,
          ...(sourceInfoBaseDir === undefined ? {} : { baseDir: sourceInfoBaseDir }),
        },
      },
    };
  });
}

export function resolveSandboxSkillRuntimeInputs(params: {
  sandbox?: SandboxSkillRuntimeContext | null;
  effectiveWorkspace: string;
  skillsSnapshot?: SkillSnapshot;
}): {
  skillsEligibility?: SkillEligibilityContext;
  skillsPromptWorkspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
  skillsWorkspaceDir: string;
  workspaceOnly: boolean;
} {
  if (params.sandbox?.enabled === true) {
    const skillsWorkspaceDir = params.sandbox.skillsWorkspaceDir ?? params.effectiveWorkspace;
    const skillsPromptWorkspaceDir =
      params.sandbox.workspaceAccess === "rw" &&
      params.sandbox.skillsWorkspaceDir &&
      params.sandbox.containerWorkdir
        ? containerJoin(
            params.sandbox.containerWorkdir,
            ...MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS,
          )
        : (params.sandbox.containerWorkdir ?? skillsWorkspaceDir);
    return {
      ...(params.sandbox.skillsEligibility
        ? { skillsEligibility: params.sandbox.skillsEligibility }
        : {}),
      skillsPromptWorkspaceDir,
      skillsSnapshot: undefined,
      skillsWorkspaceDir,
      workspaceOnly: true,
    };
  }
  return {
    skillsPromptWorkspaceDir: params.effectiveWorkspace,
    skillsSnapshot: params.skillsSnapshot,
    skillsWorkspaceDir: params.effectiveWorkspace,
    workspaceOnly: false,
  };
}

/**
 * Builds the prompt-facing skills text and applies skill env overrides for an
 * embedded run, given the workspace inputs from {@link resolveSandboxSkillRuntimeInputs}.
 *
 * `resolveSandboxSkillRuntimeInputs` returns `skillsSnapshot: undefined` for every
 * sandboxed run, so a present snapshot means a non-sandbox run whose host paths are
 * already readable. When absent, entries are loaded fresh and their host paths are
 * remapped to the in-container copies; otherwise the prompt would hand the sandbox
 * unreadable absolute paths (e.g. `/usr/lib/node_modules/openclaw/skills/...`).
 *
 * Returns the env-restore closure the caller must invoke during run teardown.
 */
export function resolveEmbeddedRunSkillsPrompt(params: {
  skillsEligibility?: SkillEligibilityContext;
  skillsPromptWorkspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
  skillsWorkspaceDir: string;
  workspaceOnly: boolean;
  config?: OpenClawConfig;
  agentId?: string;
}): { restoreSkillEnv: () => void; skillsPrompt: string } {
  const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
  const skillEntries = shouldLoadSkillEntries
    ? loadWorkspaceSkillEntries(params.skillsWorkspaceDir, {
        config: params.config,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.skillsEligibility ? { eligibility: params.skillsEligibility } : {}),
        ...(params.workspaceOnly ? { workspaceOnly: true } : {}),
      })
    : [];
  const restoreSkillEnv = params.skillsSnapshot
    ? applySkillEnvOverridesFromSnapshot({
        snapshot: params.skillsSnapshot,
        config: params.config,
      })
    : applySkillEnvOverrides({
        skills: skillEntries,
        config: params.config,
      });
  const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
    entries: shouldLoadSkillEntries ? skillEntries : undefined,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    skillsPromptWorkspaceDir: params.skillsPromptWorkspaceDir,
  });
  const skillsPrompt = resolveSkillsPromptForRun({
    skillsSnapshot: params.skillsSnapshot,
    entries: promptSkillEntries,
    config: params.config,
    workspaceDir: params.skillsPromptWorkspaceDir,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.skillsEligibility ? { eligibility: params.skillsEligibility } : {}),
  });
  return { restoreSkillEnv, skillsPrompt };
}
