import path from "node:path";
import type {
  WorkboardCard,
  WorkboardNodePreview,
  WorkboardOrchestrationSettings,
  WorkboardPreviewSecretRef,
  WorkboardPreviewSettings,
} from "@openclaw/workboard-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { checkoutDetachedWorktree } from "./node-ticket-verification.js";
import {
  nodeTicketTarget,
  runNodeCommand,
  type WorkboardNodeTicketRuntime,
} from "./node-ticket.js";
import { cardBoardId } from "./store-card-helpers.js";
import type { WorkboardStore } from "./store.js";

// A stack's first `up` can build images for minutes.
const PREVIEW_UP_TIMEOUT_MS = 15 * 60_000;
const PREVIEW_DOWN_TIMEOUT_MS = 5 * 60_000;
// A failed command's message starts with the command and ends with its output.
const PREVIEW_ERROR_HEAD_CHARS = 150;
const PREVIEW_ERROR_TAIL_CHARS = 250;

type NodeTarget = NonNullable<ReturnType<typeof nodeTicketTarget>>;

/** A node ticket card with its recorded worktree, which preview writes are fenced on. */
type PreviewCard = { card: WorkboardCard; target: NodeTarget; worktreePath: string };

type StartingPreview = Extract<WorkboardNodePreview, { state: "starting" }>;

/** The preview a card should have: its imported head, while it waits in review on a board with previews. */
type PreviewWant = {
  headCommit: string;
  settings: WorkboardPreviewSettings;
  projectEnv: Record<string, string> | undefined;
};

type StartStep = "checkout" | "env" | "up" | "serve" | "status";

/** Each step's failure names what broke and the operator's next action. */
const STEP_FAILURES: Record<StartStep, (nodeId: string, detail: string) => string> = {
  checkout: (nodeId, detail) =>
    `Could not check out the reviewed head on ${nodeId}: ${detail}. Retry once the commit is in the node clone.`,
  // resolvePreviewEnv's error already names the variable and the next action.
  env: (_nodeId, detail) => detail,
  up: (nodeId, detail) =>
    `The board's preview up failed on ${nodeId}: ${detail}. Fix the stack or the board's preview.up, then Retry.`,
  serve: (nodeId, detail) =>
    `tailscale serve failed on ${nodeId}: ${detail}. Run \`sudo tailscale set --operator=<node user>\` on the node once, then Retry.`,
  status: (nodeId, detail) =>
    `Could not read the tailnet name of ${nodeId}: ${detail}. Retry once tailscale is up there.`,
};

function previewWant(
  card: WorkboardCard,
  board: WorkboardOrchestrationSettings | undefined,
): PreviewWant | undefined {
  const settings = board?.preview;
  const handoff = nodeTicketTarget(card)?.worktree?.handoff;
  // Nobody reviews a probe's round.
  if (
    !settings ||
    card.status !== "review" ||
    card.metadata?.archivedAt ||
    card.metadata?.automation?.probe ||
    handoff?.phase !== "imported"
  ) {
    return undefined;
  }
  return { headCommit: handoff.headCommit, settings, projectEnv: board?.env };
}

function substitute(argv: readonly string[], port: number, cardId: string): string[] {
  return argv.map((arg) =>
    arg.replaceAll("{port}", String(port)).replaceAll("{card}", cardId.slice(0, 8)),
  );
}

/**
 * The error's start and end, which name the failed command and how its output
 * ended; verbatim `secrets` are cut out first, since `up` may echo its
 * environment. Longest first, so a value containing another is cut whole, and
 * before formatErrorMessage, whose log masking keeps a long value's ends.
 */
function errorDetail(error: unknown, secrets: readonly string[] = []): string {
  const redacted =
    secrets.length === 0
      ? error
      : secrets
          .toSorted((a, b) => b.length - a.length)
          .reduce(
            (text, secret) => text.replaceAll(secret, "[redacted]"),
            error instanceof Error ? error.message : String(error),
          );
  const message = formatErrorMessage(redacted).trim();
  return message.length > PREVIEW_ERROR_HEAD_CHARS + PREVIEW_ERROR_TAIL_CHARS
    ? `${message.slice(0, PREVIEW_ERROR_HEAD_CHARS)}…${message.slice(-PREVIEW_ERROR_TAIL_CHARS)}`
    : message;
}

/**
 * Resolves the board's preview env through the Gateway's secret providers at
 * each start, so a rotated secret reaches the next preview.
 */
async function resolvePreviewEnv(
  env: Record<string, WorkboardPreviewSecretRef> | undefined,
  config: OpenClawConfig,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [name, ref] of Object.entries(env ?? {})) {
    const result = await resolveConfiguredSecretInputString({
      config,
      env: process.env,
      value: ref,
      path: `preview.env.${name}`,
      unresolvedReasonStyle: "detailed",
    });
    if (result.value === undefined) {
      throw new Error(
        `Preview secret ${name} could not be resolved: ${result.unresolvedRefReason ?? "no value"} Store it with \`openclaw secrets store set ${ref.id}\`, then Retry.`,
      );
    }
    resolved[name] = result.value;
  }
  return resolved;
}

/** The node's MagicDNS name from `tailscale status --json`, without the trailing dot. */
function tailnetName(status: string): string {
  const parsed: unknown = JSON.parse(status);
  const name = isRecord(parsed) && isRecord(parsed.Self) ? parsed.Self.DNSName : undefined;
  const trimmed = typeof name === "string" ? name.replace(/\.$/, "") : "";
  if (!trimmed) {
    throw new Error("tailscale status has no Self.DNSName; is MagicDNS on?");
  }
  return trimmed;
}

/**
 * Owns node tickets' review previews: while a card waits in review on an
 * imported round and its board has a `preview`, the board's stack runs on the
 * node that built it, in a detached worktree of the imported head, served on
 * the tailnet by the node's own `tailscale serve`. Leaving review, archiving,
 * or a new head tears it down. A pure function of card and board state,
 * retried by every pass: a teardown that fails keeps its record for the next
 * pass, a failed start keeps its record until the operator's Retry. Each card
 * runs at most once at a time, so a long `up` holds back no other card.
 */
export function createNodePreviews(params: {
  store: WorkboardStore;
  runtime: WorkboardNodeTicketRuntime;
  /** The Gateway's current config, which preview env SecretRefs resolve against. */
  config: () => OpenClawConfig;
  now: () => number;
}) {
  const { store, runtime, config, now } = params;
  const inFlight = new Set<string>();
  // Port picks run one at a time, so two starts never take the same port.
  let allocation: Promise<unknown> = Promise.resolve();
  const allocate = <T>(run: () => Promise<T>): Promise<T> => {
    const next = allocation.then(run);
    allocation = next.catch(() => undefined);
    return next;
  };

  const teardown = async (
    { card, target, worktreePath }: PreviewCard,
    record: WorkboardNodePreview,
    warn: (message: string) => void,
  ): Promise<boolean> => {
    const node = (argv: string[], options?: { cwd?: string; timeoutMs?: number }) =>
      runNodeCommand(runtime, record.nodeId, argv, options);
    if (record.port !== undefined) {
      // Unserving a port nothing serves fails; a stale route is replaced when the port is served again.
      await node(["tailscale", "serve", `--https=${record.port}`, "off"]).catch((error: unknown) =>
        warn(
          `workboard: could not unserve port ${record.port} on ${record.nodeId} for card ${card.id}: ${errorDetail(error)}`,
        ),
      );
    }
    try {
      const listed = await node(["git", "-C", target.repoPath, "worktree", "list", "--porcelain"]);
      // git lists real paths, and the record may reach the worktree through a
      // symlinked worktrees root; the card id makes the directory name unique.
      const name = path.posix.basename(record.path);
      const exists = listed
        .split("\n")
        .some((line) => line.startsWith("worktree ") && path.posix.basename(line) === name);
      if (exists) {
        if (record.down.length > 0) {
          await node(record.down, { cwd: record.path, timeoutMs: PREVIEW_DOWN_TIMEOUT_MS });
        }
        await node(["git", "-C", target.repoPath, "worktree", "remove", "--force", record.path]);
      }
    } catch (error) {
      warn(
        `workboard: could not stop the review preview of card ${card.id} on ${record.nodeId}; the next pass retries: ${errorDetail(error)}`,
      );
      return false;
    }
    return await store.setNodePreview(card.id, {
      worktreePath,
      expectedAt: record.at,
      preview: undefined,
    });
  };

  const start = async ({ card, target, worktreePath }: PreviewCard, want: PreviewWant) => {
    const previewPath = path.posix.join(target.worktreesRoot, `wb-${card.id}-preview`);
    const { from, to } = want.settings.ports;
    const starting = await allocate(async () => {
      const held = new Set<number>();
      for (const other of await store.list()) {
        const preview = nodeTicketTarget(other)?.worktree?.preview;
        if (other.id !== card.id && preview?.nodeId === target.nodeId && preview.port) {
          held.add(preview.port);
        }
      }
      const base = { headCommit: want.headCommit, nodeId: target.nodeId, path: previewPath };
      let port = from;
      while (port <= to && held.has(port)) {
        port += 1;
      }
      if (port > to) {
        await store.setNodePreview(card.id, {
          worktreePath,
          expectedAt: undefined,
          preview: {
            ...base,
            down: [],
            state: "failed",
            error: `No preview port free on ${target.nodeId}: ${to - from + 1} previews running.`,
            at: now(),
          },
        });
        return undefined;
      }
      const record: StartingPreview = {
        ...base,
        down: substitute(want.settings.down, port, card.id),
        state: "starting",
        port,
        at: now(),
      };
      const written = await store.setNodePreview(card.id, {
        worktreePath,
        expectedAt: undefined,
        preview: record,
      });
      return written ? record : undefined;
    });
    if (!starting) {
      return;
    }
    const { port } = starting;
    const node = (
      argv: string[],
      options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
    ) => runNodeCommand(runtime, target.nodeId, argv, options);
    let step: StartStep = "checkout";
    let secrets: string[] = [];
    let next: WorkboardNodePreview;
    try {
      await checkoutDetachedWorktree(runtime, target, previewPath, want.headCommit);
      step = "env";
      const resolved = await resolvePreviewEnv(want.settings.env, config());
      secrets = Object.values(resolved);
      const env = { ...want.projectEnv, ...resolved };
      step = "up";
      await node(substitute(want.settings.up, port, card.id), {
        cwd: previewPath,
        timeoutMs: PREVIEW_UP_TIMEOUT_MS,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      });
      step = "serve";
      await node(["tailscale", "serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]);
      step = "status";
      const name = tailnetName(await node(["tailscale", "status", "--self", "--json"]));
      next = { ...starting, state: "up", url: `https://${name}:${port}`, at: now() };
    } catch (error) {
      next = {
        ...starting,
        state: "failed",
        error: STEP_FAILURES[step](target.nodeId, errorDetail(error, secrets)),
        at: now(),
      };
    }
    await store.setNodePreview(card.id, { worktreePath, expectedAt: starting.at, preview: next });
  };

  /**
   * One pass over the cards. `stopped` ends the wait for this pass's runs, not
   * the runs: a stopping service does not wait out a long `up`.
   */
  return async function syncPreviews(
    warn: (message: string) => void,
    stopped?: AbortSignal,
  ): Promise<void> {
    const boards = new Map<string, Promise<WorkboardOrchestrationSettings | undefined>>();
    const settingsOf = (card: WorkboardCard) => {
      const boardId = cardBoardId(card);
      let settings = boards.get(boardId);
      if (!settings) {
        settings = store.boardOrchestration(boardId);
        boards.set(boardId, settings);
      }
      return settings;
    };
    const runs: Promise<void>[] = [];
    for (const listed of await store.list()) {
      const listedTarget = nodeTicketTarget(listed);
      if (
        !listedTarget?.worktree ||
        (!listedTarget.worktree.preview && listed.status !== "review") ||
        inFlight.has(listed.id)
      ) {
        continue;
      }
      // Claimed before any await, so an overlapping pass skips the card.
      inFlight.add(listed.id);
      runs.push(
        (async () => {
          // Decide on the card as it is now: the listing may predate another pass's run.
          const card = await store.get(listed.id);
          const target = card && nodeTicketTarget(card);
          const worktree = target?.worktree;
          if (!card || !target || !worktree) {
            return;
          }
          const settings = await settingsOf(card).catch((error: unknown) => {
            warn(
              `workboard review previews could not read board ${cardBoardId(card)}: ${errorDetail(error)}`,
            );
            return null;
          });
          // An unread board leaves the card as it is.
          if (settings === null) {
            return;
          }
          const want = previewWant(card, settings);
          const record = worktree.preview;
          // A `starting` record no run of this process owns was cut off by a
          // restart or reset by the operator's Retry: stop what it left, start again.
          const stale =
            record !== undefined &&
            (!want || record.headCommit !== want.headCommit || record.state === "starting");
          if (!stale && (record || !want)) {
            return;
          }
          const item = { card, target, worktreePath: worktree.path };
          if (record && !(await teardown(item, record, warn))) {
            return;
          }
          if (want) {
            await start(item, want);
          }
        })()
          .catch((error: unknown) =>
            warn(`workboard review preview failed for card ${listed.id}: ${errorDetail(error)}`),
          )
          .finally(() => inFlight.delete(listed.id)),
      );
    }
    const settled = Promise.all(runs);
    if (!stopped || runs.length === 0) {
      await settled;
      return;
    }
    let onAbort = () => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve();
      stopped.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([settled, aborted]);
    } finally {
      stopped.removeEventListener("abort", onAbort);
    }
  };
}
