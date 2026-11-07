import type { WorkboardCard } from "@openclaw/workboard-contract";
import { appendComment, assertCanMutateClaimedCard } from "./store-card-helpers.js";
import { WorkboardEnrichmentStore } from "./store-enrichment.js";
import type {
  WorkboardAgentActor,
  WorkboardMutationScope,
  WorkboardPromoteInput,
} from "./store-inputs.js";
import { clearDiagnostics } from "./store-normalizers.js";
import { normalizeCappedStringList } from "./store-string-lists.js";
import { normalizeBoundedString } from "./store-value-normalizers.js";

/**
 * The dispatcher routes node tickets on `class:` labels, so only the operator
 * sets or clears them; agents move labels around them.
 */
function normalizeLabelChange(value: unknown, field: "addLabels" | "removeLabels"): string[] {
  const labels = normalizeCappedStringList(value, "labels");
  const taskClass = labels.find((label) => label.startsWith("class:"));
  if (taskClass) {
    throw new Error(`${field} cannot change ${taskClass}: class labels are operator-only.`);
  }
  return labels;
}

export class WorkboardPromoteStore extends WorkboardEnrichmentStore {
  async move(
    id: string,
    status: unknown,
    position: unknown,
    scope?: WorkboardMutationScope,
    options: {
      expectedUpdatedAt?: number;
      assertOwnerCurrent?: () => void;
      actor?: WorkboardAgentActor;
      priority?: unknown;
      addLabels?: unknown;
      removeLabels?: unknown;
    } = {},
  ): Promise<WorkboardCard> {
    const addLabels = normalizeLabelChange(options.addLabels, "addLabels");
    const removeLabels = normalizeLabelChange(options.removeLabels, "removeLabels");
    const changesLabels = options.addLabels !== undefined || options.removeLabels !== undefined;
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (current) => {
          // Recheck after every cross-host CAS conflict so a worker cannot move
          // a card claimed between the read and write.
          assertCanMutateClaimedCard(current, scope);
          return {
            status,
            position,
            priority: options.priority,
            labels: changesLabels
              ? [...current.labels.filter((label) => !removeLabels.includes(label)), ...addLabels]
              : undefined,
          };
        },
        {
          allowMetadataDependencyLinks: false,
          enforceStatusHolds: true,
          expectedUpdatedAt: options.expectedUpdatedAt,
          actor: options.actor,
        },
      );
      return result.card;
    }, options.assertOwnerCurrent);
  }

  async promote(
    id: string,
    input: WorkboardPromoteInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "promote reason");
      const result = await this.updateLatestCard(
        id,
        (current) => {
          if (current.status !== "todo") {
            throw new Error(`Cannot promote Workboard card in ${current.status}; expected todo.`);
          }
          assertCanMutateClaimedCard(current, scope === null ? undefined : scope);
          return {
            status: "ready",
            metadata: {
              ...clearDiagnostics(current.metadata, ["stranded_ready", "blocked_too_long"]),
              comments: appendComment(current.metadata?.comments, reason),
              stale: null,
            },
          };
        },
        { enforceStatusHolds: input.force !== true },
      );
      return result.card;
    });
  }
}
