/** @jsxImportSource @solidjs/web */
import type {
  WorkboardNodeFileListResult,
  WorkboardNodeFileLocateResult,
  WorkboardNodeFileLocation,
  WorkboardNodeFileSource,
  WorkboardPrototypeResult,
} from "@openclaw/workboard-contract";
import { WORKBOARD_MAX_LOCATED_FILES } from "@openclaw/workboard-contract";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { HtmlPreview } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { workboardHost } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { nodeFilePageTarget, PROTOTYPE_PAGE_ID } from "../node-file/node-file-target.ts";
import { type CardFileList, createCardFileList, type SettledList } from "./card-node-files.ts";
import { flowScreenshotPaths } from "./flow-links.ts";
import { RelativeTime } from "./view-card-time.tsx";

/**
 * One HTML file: a round's committed file or a live file in the node
 * worktree. `ownerId` is the linked card the file belongs to; absent for the
 * shown card's own files.
 */
export type HtmlFileRef = {
  key: string;
  source: WorkboardNodeFileSource;
  path: string;
  label: string;
  ownerId?: string;
};

/** `screenshots` are those a flow report links to, each with where the card shows it from. */
type LoadedHtml = { html: string; screenshots?: WorkboardNodeFileLocation[] };

type HtmlState =
  | { status: "loading" }
  | ({ status: "loaded" } & LoadedHtml)
  | { status: "failed"; error: string };

/** A kind of HTML file a node ticket's drawer shows in its own tab. */
type HtmlFileKind = {
  tab: "prototype" | "flows";
  /** The repository dir the files live in, left out of their labels. */
  dir: string;
  listMethod: string;
  read: (client: GatewayBrowserClient, cardId: string, ref: HtmlFileRef) => Promise<LoadedHtml>;
  /** The pop-out page that shows one file on its own; absent when the kind has none. */
  popoutPage?: string;
  unavailable: (error: string) => string;
  liveUnavailable: (reason: string) => string;
  failed: (error: string) => string;
  pick: () => string;
};

const readHtml = (method: string, client: GatewayBrowserClient, cardId: string, ref: HtmlFileRef) =>
  client.request<WorkboardPrototypeResult>(method, {
    id: ref.ownerId ?? cardId,
    path: ref.path,
    ...ref.source,
  });

const PROTOTYPE_FILES: HtmlFileKind = {
  tab: "prototype",
  dir: "docs/prototypes/",
  listMethod: "workboard.cards.prototypes.list",
  read: (client, cardId, ref) => readHtml("workboard.cards.prototypes.get", client, cardId, ref),
  popoutPage: PROTOTYPE_PAGE_ID,
  unavailable: (error) => t("workboard.prototypesUnavailable", { error }),
  liveUnavailable: (reason) => t("workboard.prototypesLiveUnavailable", { reason }),
  failed: (error) => t("workboard.prototypeFailed", { error }),
  pick: () => t("workboard.prototypePick"),
};

const FLOW_FILES: HtmlFileKind = {
  tab: "flows",
  dir: "docs/flows/",
  listMethod: "workboard.cards.flows.list",
  // The screenshots are located for the shown card, whichever card the report belongs to.
  read: async (client, cardId, ref) => {
    const { html } = await readHtml("workboard.cards.flows.get", client, cardId, ref);
    // A report linking to more screenshots than one call locates lists the first ones.
    const paths = flowScreenshotPaths(ref.path, html).slice(0, WORKBOARD_MAX_LOCATED_FILES);
    const located =
      paths.length > 0
        ? await client.request<WorkboardNodeFileLocateResult>(
            "workboard.cards.screenshots.locate",
            { id: cardId, paths },
          )
        : { files: [] };
    return { html, screenshots: located.files };
  },
  unavailable: (error) => t("workboard.flowsUnavailable", { error }),
  liveUnavailable: (reason) => t("workboard.flowsLiveUnavailable", { reason }),
  failed: (error) => t("workboard.flowFailed", { error }),
  pick: () => t("workboard.flowPick"),
};

/** One node ticket's HTML files of one kind on one Gateway connection, live files included. */
export type CardHtmlFiles = Omit<CardFileList, "refresh"> & {
  kind: HtmlFileKind;
  /** Lists the shown card again and retries failed reads; a no-op while the current list is loading. */
  refresh(): void;
  /** The file's HTML, read on first use. */
  html(cardId: string, ref: HtmlFileRef): HtmlState;
};

function roundLabel(round: number): string {
  return round === 0
    ? t("workboard.roundFirst")
    : t("workboard.roundRework", { number: String(round) });
}

/**
 * Live files first, newest first, then each round's committed files, newest
 * round first, then the files of linked cards in link order.
 */
function htmlFileRefs(dir: string, result: WorkboardNodeFileListResult): HtmlFileRef[] {
  const shortPath = (path: string) => (path.startsWith(dir) ? path.slice(dir.length) : path);
  const live =
    result.live?.state === "available"
      ? result.live.files.map((file): HtmlFileRef => ({
          key: `live:${file.mtimeMs}:${file.bytes}:${file.path}`,
          source: { live: true },
          path: file.path,
          label: t("workboard.prototypeLiveOption", { path: shortPath(file.path) }),
        }))
      : [];
  const committed =
    result.committed.state === "available"
      ? result.committed.rounds.toReversed().flatMap((round) =>
          round.paths.map((path): HtmlFileRef => ({
            key: `${round.commit}:${path}`,
            source: { round: round.round },
            path,
            label: `${roundLabel(round.round)} · ${shortPath(path)}`,
          })),
        )
      : [];
  const linked = (result.linked ?? []).flatMap((entry) =>
    entry.committed.state === "available"
      ? entry.committed.rounds.toReversed().flatMap((round) =>
          round.paths.map((path): HtmlFileRef => ({
            key: `linked:${entry.cardId}:${round.commit}:${path}`,
            source: { round: round.round },
            path,
            label: `${t("workboard.linkedFrom", { title: entry.title })} · ${roundLabel(round.round)} · ${shortPath(path)}`,
            ownerId: entry.cardId,
          })),
        )
      : [],
  );
  return [...live, ...committed, ...linked];
}

/** Whether the drawer offers the kind's tab: a file is listed, or listing failed. */
export function hasHtmlFiles(kind: HtmlFileKind, state: SettledList): boolean {
  return (
    state.status === "unavailable" ||
    state.result.committed.state === "unavailable" ||
    htmlFileRefs(kind.dir, state.result).length > 0
  );
}

/**
 * Created per connection, so a reconnect lists and reads afresh. Live files
 * are listed too, so the tab shows what a running or waiting session wrote.
 */
function createCardHtmlFiles(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
  kind: HtmlFileKind,
): CardHtmlFiles {
  const reads = new Map<string, HtmlState>();

  const files = createCardFileList(client, requestUpdate, {
    method: kind.listMethod,
    live: true,
    onForget: () => reads.clear(),
    // A live file rewritten since the last list has a new key; drop the stale reads.
    onListed: (result) => {
      const current = new Set(htmlFileRefs(kind.dir, result).map((ref) => ref.key));
      for (const key of reads.keys()) {
        if (key.startsWith("live:") && !current.has(key)) {
          reads.delete(key);
        }
      }
    },
  });

  return {
    kind,
    show: files.show,
    list: files.list,
    dispose: files.dispose,
    refresh() {
      if (!files.refresh()) {
        return;
      }
      for (const [key, read] of reads) {
        // A screenshot missing before may have been committed or merged since.
        if (
          read.status === "failed" ||
          (read.status === "loaded" && read.screenshots?.some((shot) => !shot.source))
        ) {
          reads.delete(key);
        }
      }
    },
    html(cardId, ref) {
      const known = reads.get(ref.key);
      if (known) {
        return known;
      }
      const pending: HtmlState = { status: "loading" };
      reads.set(ref.key, pending);
      // Started inside the chain so a throwing request still settles the read.
      void Promise.resolve()
        .then(() => kind.read(client, cardId, ref))
        .then(
          (result): HtmlState => ({ status: "loaded", ...result }),
          (error: unknown): HtmlState => ({ status: "failed", error: formatUiError(error) }),
        )
        .then((settled) => {
          // A forgotten read (drawer closed, card switched) no longer owns its key.
          if (reads.get(ref.key) === pending) {
            reads.set(ref.key, settled);
            requestUpdate();
          }
        });
      return pending;
    },
  };
}

export const createCardPrototypes = (client: GatewayBrowserClient, requestUpdate: () => void) =>
  createCardHtmlFiles(client, requestUpdate, PROTOTYPE_FILES);

export const createCardFlows = (client: GatewayBrowserClient, requestUpdate: () => void) =>
  createCardHtmlFiles(client, requestUpdate, FLOW_FILES);

/** The file the panel shows, with what its read returned. */
export type ShownHtmlFile = { ref: HtmlFileRef } & LoadedHtml;

/**
 * The drawer's tab for one kind of HTML file (Prototype, Flows). The host
 * renders the file with its scripts on the sandbox origin, apart from the
 * Control UI's storage and DOM. `above` renders between the bar and the frame.
 */
export function HtmlFilesPanel(props: {
  files: CardHtmlFiles;
  cardId: string;
  listed: SettledList;
  active: boolean;
  revision?: number;
  above?: (shown: () => ShownHtmlFile) => JSX.Element;
  /** A relative link clicked inside the shown file, as its raw href. */
  onLink?: (shown: ShownHtmlFile, href: string) => void;
}) {
  const kind = () => props.files.kind;
  const [selectedKey, setSelectedKey] = createSignal<string>();
  const loaded = () => (props.listed.status === "loaded" ? props.listed : undefined);
  const refs = createMemo(() => {
    const listed = loaded();
    return listed ? htmlFileRefs(kind().dir, listed.result) : [];
  });
  const selected = () => refs().find((ref) => ref.key === selectedKey()) ?? refs()[0];
  const html = () => {
    void props.revision;
    const ref = selected();
    return ref && props.active ? props.files.html(props.cardId, ref) : undefined;
  };
  const shown = (): ShownHtmlFile | undefined => {
    const state = html();
    const ref = selected();
    return ref && state?.status === "loaded"
      ? { ref, html: state.html, ...(state.screenshots ? { screenshots: state.screenshots } : {}) }
      : undefined;
  };
  const popoutHref = () => {
    const ref = selected();
    const page = kind().popoutPage;
    return ref && page
      ? workboardHost().navigation.pageHref(
          nodeFilePageTarget(page, {
            cardId: ref.ownerId ?? props.cardId,
            source: ref.source,
            path: ref.path,
          }),
        )
      : undefined;
  };
  const placeholder = () => {
    const state = html();
    return state?.status === "failed"
      ? kind().failed(state.error)
      : state?.status === "loading"
        ? t("workboard.screenshotLoading")
        : undefined;
  };
  const liveUnavailable = () => {
    const live = loaded()?.result.live;
    return live?.state === "unavailable" ? live.reason : undefined;
  };
  const committedUnavailable = () => {
    const committed = loaded()?.result.committed;
    return committed?.state === "unavailable" ? committed.reason : undefined;
  };
  return (
    <section
      class="workboard-detail__tabpanel workboard-detail__prototypes"
      id={`workboard-detail-panel-${kind().tab}`}
      role="tabpanel"
      aria-labelledby={`workboard-detail-tab-${kind().tab}`}
      tabindex="0"
      hidden={!props.active}
    >
      <Show
        when={loaded()}
        fallback={
          <p class="workboard-detail__empty">
            {kind().unavailable(props.listed.status === "unavailable" ? props.listed.error : "")}
          </p>
        }
      >
        {(listed) => (
          <>
            <div class="workboard-prototypes__bar">
              <Show
                when={refs().length > 1}
                fallback={
                  <span class="workboard-prototypes__name" title={selected()?.path}>
                    {selected()?.label}
                  </span>
                }
              >
                <select
                  class="workboard-prototypes__picker"
                  aria-label={kind().pick()}
                  onChange={(event) => setSelectedKey(event.currentTarget.value)}
                >
                  <For each={refs()} keyed={(ref) => ref.key}>
                    {(ref) => (
                      <option
                        value={ref().key}
                        title={ref().path}
                        selected={ref().key === selected()?.key}
                      >
                        {ref().label}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
              <Show when={popoutHref()}>
                {(href) => (
                  <a
                    class="workboard-prototypes__popout"
                    href={href()}
                    target="_blank"
                    rel="noopener"
                  >
                    {t("workboard.prototypeOpenWindow")}
                  </a>
                )}
              </Show>
              <span class="workboard-screens__listed">
                <RelativeTime timestamp={listed().listedAt} now={Date.now()} format="listed" />
              </span>
              <button
                type="button"
                class="btn btn--icon btn--ghost workboard-screens__refresh"
                aria-label={t("workboard.screensRefresh")}
                title={t("workboard.screensRefresh")}
                onClick={() => props.files.refresh()}
              >
                {icons.refresh}
              </button>
            </div>
            <Show when={liveUnavailable()}>
              {(reason) => (
                <p class="workboard-screens__unavailable" role="status">
                  {kind().liveUnavailable(reason())}
                </p>
              )}
            </Show>
            <Show when={committedUnavailable()}>
              {(reason) => (
                <p class="workboard-screens__unavailable" role="status">
                  {kind().unavailable(reason())}
                </p>
              )}
            </Show>
            <Show when={placeholder()}>
              {(text) => <p class="workboard-prototypes__placeholder">{text()}</p>}
            </Show>
            <Show when={shown()}>
              {(file) => (
                <>
                  {props.above?.(file)}
                  <HtmlPreview
                    class="workboard-prototypes__frame"
                    html={file().html}
                    title={file().ref.path}
                    {...(props.onLink
                      ? { onLink: (href: string) => props.onLink?.(file(), href) }
                      : {})}
                  />
                </>
              )}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
