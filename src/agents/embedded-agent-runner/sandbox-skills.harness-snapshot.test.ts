// Plugin harnesses render the skills catalog from the snapshot they receive;
// inside a sandbox that snapshot must point at the materialized copies.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../../skills/loading/skill-contract.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveSandboxHarnessSkillsSnapshot } from "./sandbox-skills.js";

const hostSkillPath = "/usr/lib/node_modules/openclaw/skills/demo/SKILL.md";
const hostSkillBaseDir = "/usr/lib/node_modules/openclaw/skills/demo";
const hostSnapshot: SkillSnapshot = {
  prompt: `<available_skills>\n  <skill>\n    <name>demo</name>\n    <description>Demo skill</description>\n    <location>${hostSkillPath}</location>\n  </skill>\n</available_skills>`,
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

describe("resolveSandboxHarnessSkillsSnapshot", () => {
  it("hands a plugin harness the materialized skill locations instead of host paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-harness-skills-"));
    try {
      const materializedWorkspace = path.join(root, "state", "sandbox-skills");
      const skillDir = path.join(materializedWorkspace, "skills", "demo");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        ["---", "name: demo", "description: Demo skill", "---", "# Demo", ""].join("\n"),
        "utf8",
      );
      const materializedReadPath = path.join(skillDir, "SKILL.md");

      const result = resolveSandboxHarnessSkillsSnapshot({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: materializedWorkspace,
          workspaceAccess: "rw",
          skillUsagePaths: [
            {
              readPath: materializedReadPath,
              skillFile: hostSkillPath,
              skillName: "demo",
              skillSource: "openclaw-bundled",
            },
          ],
        },
        skillsAnchorWorkspace: path.join(root, "workspace"),
        skillsSnapshot: hostSnapshot,
      });

      expect(result.skillsSnapshot?.prompt).toContain(
        "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
      );
      expect(result.skillsSnapshot?.prompt).not.toContain(hostSkillPath);
      expect(result.skillsSnapshot?.skills.map((skill) => skill.name)).toEqual(["demo"]);
      expect(result.skillReferencePaths).toEqual([
        {
          readPath: "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
          skillFile: hostSkillPath,
          skillName: "demo",
          skillSource: "openclaw-bundled",
        },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicitly empty snapshot empty", () => {
    const empty: SkillSnapshot = { prompt: "", skills: [] };
    expect(
      resolveSandboxHarnessSkillsSnapshot({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: "/state/sandbox-skills",
          workspaceAccess: "rw",
        },
        skillsAnchorWorkspace: "/workspace",
        skillsSnapshot: empty,
      }).skillsSnapshot,
    ).toBe(empty);
  });
});
