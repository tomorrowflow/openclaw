import { randomUUID } from "node:crypto";
import type { WorkboardCard, WorkboardProbesResult } from "@openclaw/workboard-contract";
import {
  liveNodeProbe,
  nodeProbeCreate,
  type NodeProbeRequest,
  projectWorkboardProbes,
} from "./node-ticket-probe.js";
import { MAX_CARD_COMMENTS } from "./store-constants.js";
import { WorkboardNodeWorktreeStore } from "./store-node-worktree.js";
import { normalizeBoardId } from "./store-normalizers.js";

/** Probe cards: past node tickets re-run under a named harness arm. */
export class WorkboardNodeProbeStore extends WorkboardNodeWorktreeStore {
  /**
   * The operator's probe of a node ticket under `arm`: a new todo card, or the
   * one this source and arm already have while it is not archived.
   */
  async createNodeProbe(
    sourceId: string,
    request: NodeProbeRequest,
  ): Promise<{ card: WorkboardCard; created: boolean }> {
    return await this.enqueueMutation(async () => {
      const cards = await this.list();
      const existing = liveNodeProbe(cards, sourceId, request.arm);
      if (existing) {
        return { card: existing, created: false };
      }
      const source = cards.find((card) => card.id === sourceId);
      if (!source) {
        throw new Error(`card not found: ${sourceId}`);
      }
      const { input, probe } = nodeProbeCreate(source, request, Date.now());
      return { card: await this.createDirect(input, undefined, { probe }), created: true };
    });
  }

  /**
   * Archives an ended probe with its notice in one write, while `applies`
   * still holds for the card as stored; undefined when it no longer does.
   */
  async archiveNodeProbe(
    id: string,
    input: { body: string; applies: (card: WorkboardCard) => boolean },
  ): Promise<WorkboardCard | undefined> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(id, (card) => {
        if (!input.applies(card)) {
          return undefined;
        }
        const now = Date.now();
        return {
          metadata: {
            ...card.metadata,
            archivedAt: now,
            comments: [
              ...(card.metadata?.comments ?? []),
              { id: randomUUID(), body: input.body, createdAt: now },
            ].slice(-MAX_CARD_COMMENTS),
          },
        };
      });
      return result.updated ? result.card : undefined;
    });
  }

  /** A board's probe cards, or one source card's with `of`, projected on read. */
  async probes(
    input: { boardId?: unknown; of?: unknown },
    now = Date.now(),
  ): Promise<WorkboardProbesResult> {
    const boardId = normalizeBoardId(input.boardId);
    const of = typeof input.of === "string" && input.of.trim() ? input.of.trim() : undefined;
    return projectWorkboardProbes(await this.list({ boardId }), boardId ?? "all", now, of);
  }
}
