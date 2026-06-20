// Sandbox skill input tests cover snapshot suppression and synced skill workspace selection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../../skills/loading/skill-contract.js";
import { resolveSkillsPromptForRun } from "../../skills/loading/workspace.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveEmbeddedRunSkillsPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";

const hostSkillPath = "/usr/lib/node_modules/openclaw/skills/demo/SKILL.md";
const hostSkillBaseDir = "/usr/lib/node_modules/openclaw/skills/demo";
const snapshot: SkillSnapshot = {
  prompt:
    "<available_skills><skill><location>/usr/lib/node_modules/openclaw/skills/demo/SKILL.md</location></skill></available_skills>",
  skills: [{ name: "demo" }],
  resolvedSkills: [
    {
      name: "demo",
      description: "Demo skill",
      filePath: hostSkillPath,
      baseDir: hostSkillBaseDir,
      source: "openclaw-bundled",
      sourceInfo: createSyntheticSourceInfo(hostSkillPath, {
        source: "openclaw-bundled",
        baseDir: hostSkillBaseDir,
      }),
      disableModelInvocation: false,
    },
  ],
};

describe("resolveSandboxSkillRuntimeInputs", () => {
  it("keeps snapshots for non-sandboxed runs", () => {
    expect(
      resolveSandboxSkillRuntimeInputs({
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsSnapshot: snapshot,
      skillsPromptWorkspaceDir: "/workspace",
      skillsWorkspaceDir: "/workspace",
      workspaceOnly: false,
    });
  });

  it("uses the materialized skills workspace and drops host-path snapshots for sandboxes", () => {
    const skillsEligibility = {
      remote: {
        platforms: ["linux"],
        hasBin: () => true,
        hasAnyBin: () => true,
        note: "sandbox",
      },
    };

    expect(
      resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsEligibility,
          skillsWorkspaceDir: "/state/sandbox-skills",
          workspaceAccess: "rw",
        },
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsEligibility,
      skillsSnapshot: undefined,
      skillsPromptWorkspaceDir: "/workspace/.openclaw/sandbox-skills",
      skillsWorkspaceDir: "/state/sandbox-skills",
      workspaceOnly: true,
    });
  });

  it("falls back to the effective workspace for older sandbox contexts", () => {
    expect(
      resolveSandboxSkillRuntimeInputs({
        sandbox: { enabled: true },
        effectiveWorkspace: "/workspace",
        skillsSnapshot: snapshot,
      }),
    ).toEqual({
      skillsSnapshot: undefined,
      skillsPromptWorkspaceDir: "/workspace",
      skillsWorkspaceDir: "/workspace",
      workspaceOnly: true,
    });
  });

  it("rebuilds sandbox prompts from materialized skill paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
    try {
      const effectiveWorkspace = path.join(root, "workspace");
      const materializedWorkspace = path.join(root, "state", "sandbox-skills");
      const skillDir = path.join(materializedWorkspace, "skills", "demo");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: demo",
          "description: Demo skill",
          'openclaw: {"requires":{"anyBins":["sandboxbin"]}}',
          "---",
          "# Demo",
          "",
        ].join("\n"),
        "utf8",
      );
      const skillsEligibility = {
        remote: {
          platforms: ["linux"],
          hasBin: () => false,
          hasAnyBin: (bins: string[]) => bins.includes("sandboxbin"),
          note: "sandbox",
        },
      };

      const {
        skillsEligibility: skillsEligibilityForRun,
        skillsPromptWorkspaceDir,
        skillsSnapshot: skillsSnapshotForRun,
        skillsWorkspaceDir,
        workspaceOnly,
      } = resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsEligibility,
          skillsWorkspaceDir: materializedWorkspace,
          workspaceAccess: "rw",
        },
        effectiveWorkspace,
        skillsSnapshot: snapshot,
      });
      const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
        workspaceDir: skillsWorkspaceDir,
        eligibility: skillsEligibilityForRun,
        skillsSnapshot: skillsSnapshotForRun,
        workspaceOnly,
      });
      const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
        entries: shouldLoadSkillEntries ? skillEntries : undefined,
        skillsWorkspaceDir,
        skillsPromptWorkspaceDir,
      });
      const prompt = resolveSkillsPromptForRun({
        skillsSnapshot: skillsSnapshotForRun,
        entries: promptSkillEntries,
        workspaceDir: skillsPromptWorkspaceDir,
        eligibility: skillsEligibilityForRun,
      });

      expect(prompt).toContain("/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md");
      expect(prompt.replaceAll("\\", "/")).not.toContain(
        materializedWorkspace.replaceAll("\\", "/"),
      );
      expect(prompt).not.toContain(hostSkillPath);
      expect(prompt).not.toContain("plugin-skills");
      expect(prompt.replaceAll("\\", "/")).not.toContain("/skills/canvas/SKILL.md");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds the embedded run prompt with container skill paths for rw sandboxes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-embedded-skills-"));
    try {
      const effectiveWorkspace = path.join(root, "workspace");
      const materializedWorkspace = path.join(root, "state", "sandbox-skills");
      const skillDir = path.join(materializedWorkspace, "skills", "demo");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        ["---", "name: demo", "description: Demo skill", "---", "# Demo", ""].join("\n"),
        "utf8",
      );

      // Production composition: a rw sandbox drops the host snapshot, so the prompt
      // must be rebuilt from in-container paths, never the host bundled-install path.
      const inputs = resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: materializedWorkspace,
          workspaceAccess: "rw",
        },
        effectiveWorkspace,
        skillsSnapshot: snapshot,
      });
      const { restoreSkillEnv, skillsPrompt } = resolveEmbeddedRunSkillsPrompt({
        skillsPromptWorkspaceDir: inputs.skillsPromptWorkspaceDir,
        skillsSnapshot: inputs.skillsSnapshot,
        skillsWorkspaceDir: inputs.skillsWorkspaceDir,
        workspaceOnly: inputs.workspaceOnly,
      });
      try {
        expect(skillsPrompt).toContain("/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md");
        expect(skillsPrompt).not.toContain(hostSkillPath);
        expect(skillsPrompt.replaceAll("\\", "/")).not.toContain(
          materializedWorkspace.replaceAll("\\", "/"),
        );
      } finally {
        restoreSkillEnv();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns the host snapshot prompt verbatim for non-sandboxed runs", () => {
    const inputs = resolveSandboxSkillRuntimeInputs({
      effectiveWorkspace: "/workspace",
      skillsSnapshot: snapshot,
    });
    const { restoreSkillEnv, skillsPrompt } = resolveEmbeddedRunSkillsPrompt({
      skillsPromptWorkspaceDir: inputs.skillsPromptWorkspaceDir,
      skillsSnapshot: inputs.skillsSnapshot,
      skillsWorkspaceDir: inputs.skillsWorkspaceDir,
      workspaceOnly: inputs.workspaceOnly,
    });
    try {
      expect(skillsPrompt).toBe(snapshot.prompt);
    } finally {
      restoreSkillEnv();
    }
  });

  it("preserves remote eligibility when rebuilding sandbox prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
    try {
      const skillDir = path.join(root, "skills", "macskill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: macskill",
          "description: Mac-only remote skill",
          'openclaw: {"os":["darwin"]}',
          "---",
          "# Mac Skill",
          "",
        ].join("\n"),
        "utf8",
      );
      const skillsEligibility = {
        remote: {
          platforms: ["darwin"],
          hasBin: () => false,
          hasAnyBin: () => false,
          note: "remote mac available",
        },
      };

      const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
        workspaceDir: root,
        eligibility: skillsEligibility,
        workspaceOnly: true,
      });
      const prompt = resolveSkillsPromptForRun({
        entries: shouldLoadSkillEntries ? skillEntries : undefined,
        workspaceDir: root,
        eligibility: skillsEligibility,
      });

      expect(prompt).toContain("remote mac available");
      expect(prompt).toContain("macskill");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
