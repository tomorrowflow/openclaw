/** @jsxImportSource @solidjs/web */
import type {
  WorkboardChangeDiffResult,
  WorkboardNodeChangedFile,
  WorkboardNodeChanges,
} from "@openclaw/workboard-contract";
import { For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.tsx";
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

function Diff(props: { state: DiffState | undefined }) {
  return (
    <>
      {!props.state || props.state.status === "loading" ? (
        <p class="workboard-change__note">{t("workboard.changesDiffLoading")}</p>
      ) : props.state.status === "failed" ? (
        <p class="workboard-change__note">
          {t("workboard.changesDiffFailed", { error: props.state.error })}
        </p>
      ) : (
        <LoadedDiff result={props.state.result} />
      )}
    </>
  );
}

function LoadedDiff(props: { result: WorkboardChangeDiffResult }) {
  return (
    <>
      <pre class="workboard-change__diff">
        <For each={props.result.diff.split("\n")} keyed={false}>
          {(line) => <span class={diffLineClass(line())}>{line()}</span>}
        </For>
      </pre>
      <Show when={props.result.truncated}>
        <p class="workboard-change__note">{t("workboard.changesDiffTruncated")}</p>
      </Show>
    </>
  );
}

type ChangesView = { changes: CardChanges; card: WorkboardCard; revision?: number };

function ChangedFile(
  props: ChangesView & {
    round: number;
    roundChanges: WorkboardNodeChanges;
    file: WorkboardNodeChangedFile;
    widest: number;
    compare: string | undefined;
  },
) {
  const expanded = () => {
    void props.revision;
    return props.changes.expanded(props.card.id, props.roundChanges, props.file.path);
  };
  const anchor = () => {
    void props.revision;
    return props.compare ? props.changes.anchor(props.file.path) : undefined;
  };
  const counts = () => ("binary" in props.file ? undefined : props.file);
  return (
    <li>
      <details
        class="workboard-change"
        open={expanded()}
        onToggle={(event) => {
          const { open } = event.currentTarget;
          if (open !== props.changes.expanded(props.card.id, props.roundChanges, props.file.path)) {
            props.changes.toggle(
              props.card.id,
              props.round,
              props.roundChanges,
              props.file.path,
              open,
            );
          }
        }}
      >
        <summary>
          <code title={props.file.path}>{props.file.path}</code>{" "}
          <Show
            when={counts()}
            fallback={
              <>
                <span class="workboard-round__counts">{t("workboard.roundBinary")}</span>
                <span />
              </>
            }
          >
            {(file) => (
              <>
                <span class="workboard-round__counts">
                  <span class="workboard-round__added">+{file().added}</span>{" "}
                  <span class="workboard-round__deleted">−{file().deleted}</span>
                </span>
                <span class="workboard-round__bar" aria-hidden="true">
                  <span
                    class="workboard-round__bar-added"
                    style={{ "inline-size": `${(file().added / props.widest) * 100}%` }}
                  />
                  <span
                    class="workboard-round__bar-deleted"
                    style={{ "inline-size": `${(file().deleted / props.widest) * 100}%` }}
                  />
                </span>
              </>
            )}
          </Show>
          <Show when={props.compare} fallback={<span />}>
            {(compare) => (
              <a
                class="workboard-change__github"
                href={anchor() ? `${compare()}#${anchor()}` : compare()}
                target="_blank"
                rel="noopener noreferrer"
                title={t("workboard.changesViewOnGitHub")}
                aria-label={t("workboard.changesViewOnGitHubFile", { path: props.file.path })}
              >
                {icons.gitPullRequest}
              </a>
            )}
          </Show>{" "}
          <Show when={props.file.previousPath}>
            {(previous) => (
              <span class="workboard-round__renamed">
                {t("workboard.roundRenamedFrom", { path: previous() })}
              </span>
            )}
          </Show>
        </summary>
        <Show when={expanded()}>
          <Diff
            state={(() => {
              void props.revision;
              return props.changes.diff(props.roundChanges, props.file.path);
            })()}
          />
        </Show>
      </details>
    </li>
  );
}

function roundChanges(card: WorkboardCard) {
  return (card.rounds ?? []).flatMap((entry) =>
    entry.changes ? [{ round: entry.round, changes: entry.changes }] : [],
  );
}

export function hasCardChanges(card: WorkboardCard): boolean {
  return roundChanges(card).length > 0;
}

function ChangesRound(props: ChangesView & { round: number; roundChanges: WorkboardNodeChanges }) {
  const widest = () =>
    Math.max(
      1,
      ...props.roundChanges.files.map((file) => ("binary" in file ? 0 : file.added + file.deleted)),
    );
  const unlisted = () => props.roundChanges.totals.files - props.roundChanges.files.length;
  const compare = () => compareUrl(props.card, props.round, props.roundChanges);
  return (
    <section class="workboard-detail__section workboard-round">
      <h3>
        {props.round === 0
          ? t("workboard.roundFirst")
          : t("workboard.roundRework", { number: String(props.round) })}{" "}
        <span class="workboard-round__totals">
          {t("workboard.roundChangeTotals", {
            files: String(props.roundChanges.totals.files),
            added: String(props.roundChanges.totals.added),
            deleted: String(props.roundChanges.totals.deleted),
          })}
        </span>{" "}
        <Show when={compare()}>
          {(url) => (
            <a
              class="workboard-change__compare"
              href={url()}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("workboard.changesViewOnGitHub")}
            </a>
          )}
        </Show>
      </h3>
      <ul class="workboard-round__files">
        <For each={props.roundChanges.files} keyed={(file) => file.path}>
          {(file) => (
            <ChangedFile
              changes={props.changes}
              card={props.card}
              revision={props.revision}
              round={props.round}
              roundChanges={props.roundChanges}
              file={file()}
              widest={widest()}
              compare={compare()}
            />
          )}
        </For>
      </ul>
      <Show when={unlisted() > 0}>
        <p class="workboard-round__more">
          {t("workboard.roundMoreFiles", { count: String(unlisted()) })}
        </p>
      </Show>
    </section>
  );
}

/** The Changes tab: each round's changed files, newest round first, each opening to its diff. */
export function ChangesPanel(props: ChangesView & { active: boolean }) {
  return (
    <section
      class="workboard-detail__tabpanel workboard-detail__changes"
      id="workboard-detail-panel-changes"
      role="tabpanel"
      aria-labelledby="workboard-detail-tab-changes"
      tabindex="0"
      hidden={!props.active}
    >
      <Show when={props.active}>
        <For
          each={roundChanges(props.card).toReversed()}
          keyed={(entry) => `${entry.round}:${entry.changes.from}..${entry.changes.to}`}
        >
          {(entry) => (
            <ChangesRound
              changes={props.changes}
              card={props.card}
              revision={props.revision}
              round={entry().round}
              roundChanges={entry().changes}
            />
          )}
        </For>
      </Show>
    </section>
  );
}
