import type {
  WorkboardChangeDiffResult,
  WorkboardNodeChangedFile,
  WorkboardNodeChanges,
} from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";

type DiffState =
  | { status: "loading" }
  | { status: "loaded"; result: WorkboardChangeDiffResult }
  | { status: "failed"; error: string };

/** The drawer card's opened file diffs on one Gateway connection. */
export type CardChanges = {
  /** Whether the file's diff is expanded; its read starts on expand. */
  expanded(cardId: string, changes: WorkboardNodeChanges, path: string): boolean;
  toggle(
    cardId: string,
    round: number,
    changes: WorkboardNodeChanges,
    path: string,
    open: boolean,
  ): void;
  diff(changes: WorkboardNodeChanges, path: string): DiffState | undefined;
  /** GitHub's anchor for the file in a diff view, once hashed. */
  anchor(path: string): string | undefined;
  /** Reads failed diffs again. */
  refresh(): void;
  dispose(): void;
};

/**
 * Created per connection, so a reconnect reads afresh. Opening another card
 * drops the previous card's diffs, which can be large.
 */
export function createCardChanges(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): CardChanges {
  let cardId: string | undefined;
  const open = new Set<string>();
  const diffs = new Map<string, DiffState>();
  const reads = new Map<string, { id: string; round: number; path: string }>();
  const anchors = new Map<string, string | null>();
  const key = (changes: WorkboardNodeChanges, path: string) =>
    `${changes.from}..${changes.to}:${path}`;
  const load = (fileKey: string) => {
    const params = reads.get(fileKey);
    if (!params) {
      return;
    }
    const pending: DiffState = { status: "loading" };
    diffs.set(fileKey, pending);
    requestUpdate();
    void Promise.resolve()
      .then(() => client.request<WorkboardChangeDiffResult>("workboard.cards.changes.diff", params))
      .then(
        (result): DiffState => ({ status: "loaded", result }),
        (error: unknown): DiffState => ({ status: "failed", error: formatUiError(error) }),
      )
      .then((settled) => {
        // Another card, or a dispose, dropped this read.
        if (diffs.get(fileKey) === pending) {
          diffs.set(fileKey, settled);
          requestUpdate();
        }
      });
  };
  const forget = () => {
    open.clear();
    diffs.clear();
    reads.clear();
  };
  return {
    expanded(id, changes, path) {
      return cardId === id && open.has(key(changes, path));
    },
    toggle(id, round, changes, path, expand) {
      if (cardId !== id) {
        cardId = id;
        forget();
      }
      const fileKey = key(changes, path);
      if (!expand) {
        open.delete(fileKey);
        return;
      }
      open.add(fileKey);
      // Reopening a failed diff reads it again.
      if (!diffs.has(fileKey) || diffs.get(fileKey)?.status === "failed") {
        reads.set(fileKey, { id, round, path });
        load(fileKey);
      }
    },
    diff(changes, path) {
      return diffs.get(key(changes, path));
    },
    anchor(path) {
      const known = anchors.get(path);
      if (known !== undefined) {
        return known ?? undefined;
      }
      anchors.set(path, null);
      // GitHub names each file in a diff view by the SHA-256 of its path.
      void crypto.subtle?.digest("SHA-256", new TextEncoder().encode(path)).then((digest) => {
        anchors.set(
          path,
          `diff-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        );
        requestUpdate();
      });
      return undefined;
    },
    refresh() {
      for (const [fileKey, state] of diffs) {
        if (state.status === "failed") {
          load(fileKey);
        }
      }
    },
    dispose() {
      cardId = undefined;
      forget();
    },
  };
}

const GITHUB_PULL_REQUEST = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+/;

/** The round's compare view on GitHub, once the round is on the PR branch. */
function compareUrl(card: WorkboardCard, round: number, changes: WorkboardNodeChanges) {
  const repository = card.pullRequestUrl?.match(GITHUB_PULL_REQUEST)?.[1];
  return repository && card.publishedRound !== undefined && round <= card.publishedRound
    ? `${repository}/compare/${changes.from}...${changes.to}`
    : undefined;
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) {
    return "workboard-change__hunk";
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "workboard-change__added";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "workboard-change__deleted";
  }
  return "";
}

// Split once per result: an open diff re-renders with every drawer update.
const diffLines = new WeakMap<WorkboardChangeDiffResult, ReturnType<typeof html>[]>();

function renderDiffLines(result: WorkboardChangeDiffResult) {
  let lines = diffLines.get(result);
  if (!lines) {
    lines = result.diff
      .split("\n")
      .map((line) => html`<span class=${diffLineClass(line)}>${line}</span>`);
    diffLines.set(result, lines);
  }
  return lines;
}

function renderDiff(state: DiffState | undefined) {
  if (!state || state.status === "loading") {
    return html`<p class="workboard-change__note">${t("workboard.changesDiffLoading")}</p>`;
  }
  if (state.status === "failed") {
    return html`<p class="workboard-change__note">
      ${t("workboard.changesDiffFailed", { error: state.error })}
    </p>`;
  }
  return html`<pre class="workboard-change__diff">${renderDiffLines(state.result)}</pre>
    ${
      state.result.truncated
        ? html`<p class="workboard-change__note">${t("workboard.changesDiffTruncated")}</p>`
        : nothing
    }`;
}

function renderFile(
  changesView: CardChanges,
  card: WorkboardCard,
  round: number,
  changes: WorkboardNodeChanges,
  file: WorkboardNodeChangedFile,
  widest: number,
  compare: string | undefined,
) {
  const expanded = changesView.expanded(card.id, changes, file.path);
  const anchor = compare ? changesView.anchor(file.path) : undefined;
  return html`<li>
    <details
      class="workboard-change"
      ?open=${expanded}
      @toggle=${(event: Event) => {
        const details = event.currentTarget;
        if (!(details instanceof HTMLDetailsElement)) {
          return;
        }
        const { open } = details;
        if (open !== changesView.expanded(card.id, changes, file.path)) {
          changesView.toggle(card.id, round, changes, file.path, open);
        }
      }}
    >
      <summary>
        <code title=${file.path}>${file.path}</code>
        ${
          "binary" in file
            ? html`<span class="workboard-round__counts">${t("workboard.roundBinary")}</span>
                <span></span>`
            : html`<span class="workboard-round__counts">
                  <span class="workboard-round__added">+${file.added}</span>
                  <span class="workboard-round__deleted">−${file.deleted}</span>
                </span>
                <span class="workboard-round__bar" aria-hidden="true">
                  <span
                    class="workboard-round__bar-added"
                    style=${`inline-size: ${(file.added / widest) * 100}%`}
                  ></span>
                  <span
                    class="workboard-round__bar-deleted"
                    style=${`inline-size: ${(file.deleted / widest) * 100}%`}
                  ></span>
                </span>`
        }
        ${
          compare
            ? html`<a
                class="workboard-change__github"
                href=${anchor ? `${compare}#${anchor}` : compare}
                target="_blank"
                rel="noopener noreferrer"
                title=${t("workboard.changesViewOnGitHub")}
                aria-label=${t("workboard.changesViewOnGitHubFile", { path: file.path })}
                >${icons.gitPullRequest}</a
              >`
            : html`<span></span>`
        }
        ${
          file.previousPath
            ? html`<span class="workboard-round__renamed">
                ${t("workboard.roundRenamedFrom", { path: file.previousPath })}
              </span>`
            : nothing
        }
      </summary>
      ${expanded ? renderDiff(changesView.diff(changes, file.path)) : nothing}
    </details>
  </li>`;
}

function roundChanges(card: WorkboardCard) {
  return (card.rounds ?? []).flatMap((entry) =>
    entry.changes ? [{ round: entry.round, changes: entry.changes }] : [],
  );
}

export function hasCardChanges(card: WorkboardCard): boolean {
  return roundChanges(card).length > 0;
}

/** The Changes tab: each round's changed files, newest round first, each opening to its diff. */
export function renderChangesPanel(changesView: CardChanges, card: WorkboardCard, active: boolean) {
  return html`<section
    class="workboard-detail__tabpanel workboard-detail__changes"
    id="workboard-detail-panel-changes"
    role="tabpanel"
    aria-labelledby="workboard-detail-tab-changes"
    tabindex="0"
    ?hidden=${!active}
  >
    ${
      active
        ? roundChanges(card)
            .toReversed()
            .map(({ round, changes }) => {
              const widest = Math.max(
                1,
                ...changes.files.map((file) => ("binary" in file ? 0 : file.added + file.deleted)),
              );
              const unlisted = changes.totals.files - changes.files.length;
              const compare = compareUrl(card, round, changes);
              return html`<section class="workboard-detail__section workboard-round">
                <h3>
                  ${
                    round === 0
                      ? t("workboard.roundFirst")
                      : t("workboard.roundRework", { number: String(round) })
                  }
                  <span class="workboard-round__totals">
                    ${t("workboard.roundChangeTotals", {
                      files: String(changes.totals.files),
                      added: String(changes.totals.added),
                      deleted: String(changes.totals.deleted),
                    })}
                  </span>
                  ${
                    compare
                      ? html`<a
                          class="workboard-change__compare"
                          href=${compare}
                          target="_blank"
                          rel="noopener noreferrer"
                          >${t("workboard.changesViewOnGitHub")}</a
                        >`
                      : nothing
                  }
                </h3>
                <ul class="workboard-round__files">
                  ${changes.files.map((file) =>
                    renderFile(changesView, card, round, changes, file, widest, compare),
                  )}
                </ul>
                ${
                  unlisted > 0
                    ? html`<p class="workboard-round__more">
                        ${t("workboard.roundMoreFiles", { count: String(unlisted) })}
                      </p>`
                    : nothing
                }
              </section>`;
            })
        : nothing
    }
  </section>`;
}
