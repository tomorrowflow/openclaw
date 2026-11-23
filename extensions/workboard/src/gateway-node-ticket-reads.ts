import { WORKBOARD_MAX_LOCATED_FILES, type WorkboardCard } from "@openclaw/workboard-contract";
import {
  listNodeTicketArtifacts,
  locateNodeTicketArtifacts,
  type NodeTicketArtifactKind,
  readNodeTicketArtifact,
  relatedCardIds,
} from "./node-ticket-artifacts.js";
import { readNodeTicketChangeDiff } from "./node-ticket-changes.js";
import type { WorkboardNodeTicketRuntime } from "./node-ticket.js";
import type { WorkboardStore } from "./store.js";

type Params = Record<string, unknown>;

/**
 * The read-only Gateway methods over a node ticket's rounds: a changed file's
 * diff, and its screenshots, prototypes, and flow reports. `register` adds one
 * operator.read method; `requireCard` resolves the card a request names.
 */
export function registerNodeTicketReadMethods(options: {
  register: (method: string, handler: (params: Params) => unknown) => void;
  requireCard: (params: Params) => Promise<WorkboardCard>;
  store: Pick<WorkboardStore, "get">;
  runtime: WorkboardNodeTicketRuntime;
}): void {
  const { register, requireCard, store, runtime } = options;
  const linkedCards = async (card: WorkboardCard) =>
    (await Promise.all(relatedCardIds(card).map((id) => store.get(id)))).filter(
      (entry) => entry !== undefined,
    );
  // operator.read suffices for the node walk: live paths stay inside the dispatcher-owned
  // worktree.path and normalized screenshotDirs, docs/prototypes, or docs/flows, and the node's
  // allowReadPaths bound them again. The walk also runs git on the node through
  // system.run, but with a fixed argv (checked commit id, normalized dirs after `--`)
  // in the worktree the ticket's agent already runs in, so a reader chooses nothing.
  const listArtifacts = async (kind: NodeTicketArtifactKind, input: Params) => {
    const card = await requireCard(input);
    return listNodeTicketArtifacts(runtime, card, kind, {
      live: input.live === true,
      linked: await linkedCards(card),
    });
  };
  const readArtifact = async (kind: NodeTicketArtifactKind, input: Params) => {
    const { round, live, base, path } = input;
    const source =
      live === true
        ? { live: true as const }
        : base === true
          ? { base: true as const }
          : typeof round === "number"
            ? { round }
            : undefined;
    if (!source || typeof path !== "string" || !path) {
      throw new Error("path and one of round, live: true, or base: true are required.");
    }
    return readNodeTicketArtifact(runtime, await requireCard(input), kind, source, path);
  };
  const readHtml = async (kind: NodeTicketArtifactKind, input: Params) => ({
    html: (await readArtifact(kind, input)).bytes.toString("utf8"),
  });

  register("workboard.cards.screenshots.list", (input) => listArtifacts("screenshot", input));
  register("workboard.cards.changes.diff", async (input) => {
    const { round, path } = input;
    if (typeof round !== "number" || typeof path !== "string" || !path) {
      throw new Error("round and path are required.");
    }
    return readNodeTicketChangeDiff(await requireCard(input), round, path);
  });
  register("workboard.cards.screenshots.get", async (input) => {
    const { mimeType, bytes } = await readArtifact("screenshot", input);
    return { mimeType, contentBase64: bytes.toString("base64") };
  });
  // Where the card shows screenshots a flow report names: its own, its linked cards', the default branch's.
  register("workboard.cards.screenshots.locate", async (input) => {
    const { paths } = input;
    if (
      !Array.isArray(paths) ||
      paths.length > WORKBOARD_MAX_LOCATED_FILES ||
      !paths.every((path) => typeof path === "string")
    ) {
      throw new Error(`paths must be a list of at most ${WORKBOARD_MAX_LOCATED_FILES} file paths.`);
    }
    const card = await requireCard(input);
    return {
      files: await locateNodeTicketArtifacts(runtime, card, "screenshot", paths, {
        linked: await linkedCards(card),
      }),
    };
  });
  register("workboard.cards.prototypes.list", (input) => listArtifacts("prototype", input));
  register("workboard.cards.prototypes.get", (input) => readHtml("prototype", input));
  register("workboard.cards.flows.list", (input) => listArtifacts("flow", input));
  register("workboard.cards.flows.get", (input) => readHtml("flow", input));
}
