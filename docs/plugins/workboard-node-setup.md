---
summary: "Set up a macOS, Linux, or Windows build node that runs Workboard node tickets headless"
read_when:
  - You want Workboard node tickets to run on a new machine
  - You are setting up a dedicated build user, its Claude login, and its node service
  - A node ticket is denied a command, can't start, or its bundle import fails
title: "Workboard build nodes"
sidebarTitle: "Workboard build nodes"
doc-schema-version: 1
---

A [node ticket](/plugins/workboard#node-tickets) runs a fresh Claude Code
session on a paired node. This page sets up such a **build node**: a
dedicated OS user that runs the node host as a service with nobody logged in,
its own Claude login and permission rules, its own clone, and the Gateway
policy that lets Workboard fetch the finished branch.

The steps are the same on every platform; only the service wrapper differs.

| Platform | Service                                                     | Status         |
| -------- | ----------------------------------------------------------- | -------------- |
| macOS    | Self-made LaunchDaemon with `UserName` (no login session)   | Proven         |
| Linux    | `openclaw connect --service` user unit, with lingering      | Proven         |
| Windows  | Self-made Scheduled Task with an S4U principal (boot start) | Not yet proven |

## What every build node needs

1. **A dedicated OS user** with no admin rights. Ticket sessions run with
   that user's files and permissions, so keep the Gateway's credentials,
   your own home, and other projects out of its reach.
2. **Git, Node 24, and the `openclaw` CLI** at the Gateway's version, plus a
   git identity for factory commits (for example `factory (dev loop)`).
3. **Its own clone** of each project repo (`repoPath`) and a worktrees root
   (`worktreesRoot`). The Gateway imports finished branches into a separate
   host clone (`hostRepoPath`); the two never share files, even on one machine.
4. **Claude Code** with a long-lived login from `claude setup-token`, exported
   as `CLAUDE_CODE_OAUTH_TOKEN` by the service. Interactive `/login` stores
   the login in places a service can't read (the macOS Keychain, for
   example). Use one token per node so you can revoke a node on its own.
5. **Claude permission rules** in the user's `~/.claude/settings.json`.
   Ticket turns run `claude -p`, which denies any tool use the rules don't
   allow ("This command requires approval").
6. **Node config** in the user's `openclaw.json`:

   ```json5 validate=false
   {
     nodeHost: {
       agentRuns: { claude: { enabled: true } },
       autoUpdate: { enabled: false },
     },
     plugins: {
       entries: {
         anthropic: { config: { sessionCatalog: { enabled: true } } },
       },
     },
   }
   ```

   Turning off node auto-update keeps the node on the Gateway's version; set
   `OPENCLAW_NO_AUTO_UPDATE=1` in the service environment too, and restart the
   node after each Gateway update.

7. **Pairing without the Gateway token.** On the Gateway host, mint a
   single-use join URL with `openclaw devices join-code`, then run
   `openclaw connect <join-url>` as the build user. The pairing is saved, so a
   later `openclaw node run` reconnects without the URL. See
   [Node host](/nodes/node-host).

### Claude permission rules

Start from this allowlist and add the project's build and test commands:

```json validate=false
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Bash(git:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(mkdir:*)",
      "Bash(pwd)",
      "Bash(echo:*)",
      "Bash(grep:*)",
      "Bash(find:*)",
      "Bash(head:*)",
      "Bash(tail:*)"
    ],
    "deny": [
      "Bash(git push:*)",
      "Bash(git remote:*)",
      "Bash(curl:*)",
      "Bash(wget:*)",
      "Bash(ssh:*)",
      "Bash(sudo:*)"
    ],
    "additionalDirectories": ["/home/factory/factory/worktrees"]
  }
}
```

- **Deny pushes and remotes.** Nodes never hold the GitHub token; only the
  Gateway publishes.
- **Allow the project's proof commands** (for example `xcodebuild`, `xcrun`
  and `swift` on a Mac, or `docker compose` on a Linux node).
- **Allow `echo`,** so a session can record exit codes in its report.
- **List the worktrees root in `additionalDirectories`.** Sessions start with
  their working directory set to the ticket worktree.

## macOS

`openclaw node install` creates a per-user LaunchAgent, which only runs
while that user is logged in. A build node uses a LaunchDaemon that names the
user instead.

1. Create a hidden standard user (for example `factory`) in System Settings
   or with `sysadminctl`, and log in as it once with `sudo -iu factory`.
2. Install Claude Code with the native installer, then run
   `claude setup-token` and save the token to
   `~/.config/openclaw-node/claude-token` with mode `600`.
3. Write the wrapper `~/bin/openclaw-node.sh` and `chmod 700` it. If it isn't
   executable, launchd exits 78 and writes an empty log.

   ```bash
   #!/bin/bash
   export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
   export OPENCLAW_NO_AUTO_UPDATE=1
   export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.config/openclaw-node/claude-token")"
   exec openclaw node run
   ```

4. Pair once in the foreground (`openclaw connect <join-url>`), then stop it.
5. As an admin, write `/Library/LaunchDaemons/ai.openclaw.factory-node.plist`
   with `UserName` set to the build user, `ProgramArguments` set to the
   wrapper, `RunAtLoad` and `KeepAlive` set to true, and log paths under the
   user's home. Then run
   `sudo launchctl bootstrap system /Library/LaunchDaemons/ai.openclaw.factory-node.plist`.
6. For iOS proof, run `sudo xcodebuild -runFirstLaunch` once. Simulators then
   boot from the daemon without a GUI session.

To restart the node, run `sudo pkill -f "openclaw node run"`; `KeepAlive`
brings it back. `launchctl kickstart -k` can hang.

## Linux

The node runs as a systemd **user** unit, so the build user needs lingering
to keep it running with nobody logged in.

1. Create the user and enable lingering:

   ```bash
   sudo useradd -m -s /bin/bash factory
   sudo passwd -l factory
   sudo loginctl enable-linger factory
   ```

2. If tickets build or test in containers, give the user **rootless Docker**
   (`sudo apt-get install uidmap`, then `dockerd-rootless-setuptool.sh install`
   as the user). Don't add a build user to the `docker` group: that is
   root-equivalent on the host, and on a Gateway host it exposes every
   secret. With rootless Docker, files a container writes into a worktree are
   owned by the build user.
3. Install Claude Code as the user, run `claude setup-token`, and save the
   token as `CLAUDE_CODE_OAUTH_TOKEN=<token>` in
   `~/.config/openclaw-node/claude.env` with mode `600`.
4. Pair and install the service as the user:
   `openclaw connect <join-url> --service`. When you switch users with
   `sudo -iu`, export `XDG_RUNTIME_DIR=/run/user/$(id -u)` first so
   `systemctl --user` works.
5. Add a drop-in
   `~/.config/systemd/user/openclaw-node.service.d/build-node.conf`, then
   `systemctl --user daemon-reload && systemctl --user restart openclaw-node`:

   ```ini
   [Service]
   EnvironmentFile=%h/.config/openclaw-node/claude.env
   Environment=DOCKER_HOST=unix:///run/user/<uid>/docker.sock
   Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
   Environment=OPENCLAW_NO_AUTO_UPDATE=1
   ```

   Reinstalling the service with `--force` keeps the drop-in.

A node on the Gateway host still uses the normal bundle path: its own clone,
File Transfer, and `allowReadPaths`.

## Windows

<Note>
This layout follows the same rules as the macOS node but has not yet been
proven end to end.
</Note>

`openclaw node install` on Windows registers an interactive per-user task,
which runs only while that user is logged on. For a headless build node,
register the task yourself with an S4U principal and a boot trigger, the
same way the managed Gateway task runs before login.

1. Create a standard local user (for example `factory`) and install Git for
   Windows, Node 24 and `openclaw` for it. Claude Code needs Git Bash for its
   Bash tool.
2. As the user, install Claude Code
   (`irm https://claude.ai/install.ps1 | iex`), run `claude setup-token`, and
   save the token to `%USERPROFILE%\.config\openclaw-node\claude-token`,
   readable only by that user.
3. Pair once in the foreground: `openclaw connect <join-url>`.
4. Write a launcher `%USERPROFILE%\bin\openclaw-node.cmd`:

   ```bat
   @echo off
   set OPENCLAW_NO_AUTO_UPDATE=1
   set /p CLAUDE_CODE_OAUTH_TOKEN=<"%USERPROFILE%\.config\openclaw-node\claude-token"
   openclaw node run
   ```

5. From an elevated terminal, register a task that runs the launcher as the
   user with **Run whether user is logged on or not** and
   **Do not store password** (S4U), a **At startup** trigger, and restart on
   failure. S4U has no network credentials, so clone over HTTPS from public
   remotes, or use credentials stored where S4U can read them.
6. In targets, write node paths with forward slashes
   (`C:/Users/factory/factory/worktrees`). Workboard joins node paths with
   `/`, and Git for Windows accepts that form.

## Gateway side

Once the node is paired:

1. Enable the File Transfer plugin (`plugins.allow` and
   `plugins.entries.file-transfer.enabled`) and allow the file commands, which
   are withheld from nodes by default:

   ```json5 validate=false
   {
     gateway: { nodes: { commands: { allow: ["file.fetch", "file.stat"] } } },
     plugins: {
       entries: {
         "file-transfer": {
           config: {
             nodes: {
               "<nodeId>": {
                 ask: "off",
                 allowReadPaths: ["/home/factory/factory/worktrees/*.bundle"],
                 followSymlinks: false,
               },
             },
           },
         },
       },
     },
   }
   ```

   Restart the node afterwards: the Gateway re-evaluates withheld commands only
   when a node reconnects. `file.fetch` is capped at 16 MiB per bundle.

2. Point a board at the node with `orchestration.defaultTarget` through
   `workboard.boards.upsert`:

   ```json validate=false
   {
     "kind": "node-claude",
     "nodeId": "<nodeId>",
     "repoPath": "/home/factory/factory/repos/<project>",
     "worktreesRoot": "/home/factory/factory/worktrees",
     "hostRepoPath": "/path/to/host/clone/<project>",
     "model": "anthropic/claude-sonnet-5-5"
   }
   ```

   The target `model` must pass the assignee's `modelPolicy.allow`.

## Verify

- `openclaw nodes describe --node <name>` lists `agent.cli.claude.run.v1`,
  `file.fetch`, and `system.run`. A missing `agent.cli.claude.run.v1` means
  the node config is off or the service can't find `claude` on its `PATH`.
- As the build user, `claude -p "Reply with: ok"` works with only
  `CLAUDE_CODE_OAUTH_TOKEN` set.
- The project's proof command runs as the build user from a clone.
- A first docs-only ticket reaches `review` with handoff `imported`.

## Troubleshooting

| Symptom                                               | Fix                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Session report says a command "requires approval"     | Add the command to the build user's `~/.claude/settings.json` allowlist.                                  |
| Session can't write files or `cd … && git` is blocked | The session didn't start in the ticket worktree; check `worktreesRoot` and `additionalDirectories`.       |
| Import fails fetching `wb-<cardId>.bundle`            | Add `<worktreesRoot>/*.bundle` to the node's `allowReadPaths`, allow `file.fetch`, then restart the node. |
| macOS daemon exits 78 with an empty log               | Make the wrapper executable (`chmod 700`).                                                                |
| Claude says it is not logged in from the service      | Export `CLAUDE_CODE_OAUTH_TOKEN` in the service environment; `/login` doesn't reach a service.            |
| Linux node stops when you log out                     | Enable lingering: `sudo loginctl enable-linger <user>`.                                                   |

## Related

- [Workboard plugin](/plugins/workboard#node-tickets)
- [Node host](/nodes/node-host)
- [File transfers](/nodes/file-transfers)
- [Anthropic provider: node Claude runs](/providers/anthropic)
