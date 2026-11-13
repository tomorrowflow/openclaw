import path from "node:path";
import { runNodeCommand, type WorkboardNodeTicketRuntime } from "./node-ticket.js";

const PROJECT_ENV_FILE = ".claude/workboard.env";

// Writes the env file and keeps it out of `git status` through the clone's own exclude file.
const PROJECT_ENV_SCRIPT = `import os, sys
path, exclude, payload = sys.argv[1:4]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    f.write(payload)
lines = open(exclude).read().splitlines() if os.path.exists(exclude) else []
if "/${PROJECT_ENV_FILE}" not in lines:
    os.makedirs(os.path.dirname(exclude), exist_ok=True)
    with open(exclude, "a") as f:
        f.write("\\n/${PROJECT_ENV_FILE}\\n")
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Hands the board's project env to the ticket's Claude Code session as
 * `export` lines in the worktree's `.claude/workboard.env`, which the node
 * profile's SessionStart hook appends to `$CLAUDE_ENV_FILE`. OpenClaw runs
 * Claude Code with user setting sources only, so the worktree's own settings
 * never load, and a variable prefix on a command would not match the node's
 * Bash allow rules. A board without env removes an earlier round's file.
 */
export async function writeNodeProjectEnv(
  runtime: WorkboardNodeTicketRuntime,
  nodeId: string,
  worktreePath: string,
  env: Record<string, string> | undefined,
): Promise<void> {
  const file = path.posix.join(worktreePath, PROJECT_ENV_FILE);
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) {
    await runNodeCommand(runtime, nodeId, ["rm", "-f", file]);
    return;
  }
  const exclude = await runNodeCommand(runtime, nodeId, [
    "git",
    "-C",
    worktreePath,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  const payload = entries.map(([name, value]) => `export ${name}=${shellQuote(value)}\n`).join("");
  await runNodeCommand(runtime, nodeId, [
    "python3",
    "-c",
    PROJECT_ENV_SCRIPT,
    file,
    exclude,
    payload,
  ]);
}
