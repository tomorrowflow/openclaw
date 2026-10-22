/** @jsxImportSource @solidjs/web */
import type {
  WorkboardNodeFileListResult,
  WorkboardNodeFileSource,
  WorkboardPrototypeResult,
} from "@openclaw/workboard-contract";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { HtmlPreview } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { workboardHost } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { prototypePageTarget } from "../prototype/prototype-target.ts";
import { type CardFileList, createCardFileList, type SettledList } from "./card-node-files.ts";
import { RelativeTime } from "./view-card-time.tsx";

/** One prototype file: a round's committed HTML or a live file in the node worktree. */
type PrototypeRef = { key: string; source: WorkboardNodeFileSource; path: string; label: string };

type HtmlState =
  | { status: "loading" }
  | { status: "loaded"; html: string }
  | { status: "failed"; error: string };

/** One node ticket's prototypes on one Gateway connection, live files included. */
export type CardPrototypes = Omit<CardFileList, "refresh"> & {
  /** Lists the shown card again and retries failed reads; a no-op while the current list is loading. */
  refresh(): void;
  /** The file's HTML, read on first use. */
  html(cardId: string, ref: PrototypeRef): HtmlState;
};

const PROTOTYPE_DIR = "docs/prototypes/";

function shortPath(path: string): string {
  return path.startsWith(PROTOTYPE_DIR) ? path.slice(PROTOTYPE_DIR.length) : path;
}

/** Live files first, newest first, then each round's committed files, newest round first. */
function prototypeRefs(result: WorkboardNodeFileListResult): PrototypeRef[] {
  const live =
    result.live?.state === "available"
      ? result.live.files.map((file): PrototypeRef => ({
          key: `live:${file.mtimeMs}:${file.bytes}:${file.path}`,
          source: { live: true },
          path: file.path,
          label: t("workboard.prototypeLiveOption", { path: shortPath(file.path) }),
        }))
      : [];
  const committed =
    result.committed.state === "available"
      ? result.committed.rounds.toReversed().flatMap((round) =>
          round.paths.map((path): PrototypeRef => ({
            key: `${round.commit}:${path}`,
            source: { round: round.round },
            path,
            label: `${
              round.round === 0
                ? t("workboard.roundFirst")
                : t("workboard.roundRework", { number: String(round.round) })
            } · ${shortPath(path)}`,
          })),
        )
      : [];
  return [...live, ...committed];
}

/** Whether the drawer offers its Prototype tab: a file is listed, or listing failed. */
export function hasPrototypes(state: SettledList): boolean {
  return (
    state.status === "unavailable" ||
    state.result.committed.state === "unavailable" ||
    prototypeRefs(state.result).length > 0
  );
}

/**
 * Created per connection, so a reconnect lists and reads afresh. Live files
 * are listed too, so the tab shows what a running or waiting session wrote.
 */
export function createCardPrototypes(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): CardPrototypes {
  const reads = new Map<string, HtmlState>();

  const files = createCardFileList(client, requestUpdate, {
    method: "workboard.cards.prototypes.list",
    live: true,
    onForget: () => reads.clear(),
    // A live file rewritten since the last list has a new key; drop the stale reads.
    onListed: (result) => {
      const current = new Set(prototypeRefs(result).map((ref) => ref.key));
      for (const key of reads.keys()) {
        if (key.startsWith("live:") && !current.has(key)) {
          reads.delete(key);
        }
      }
    },
  });

  return {
    show: files.show,
    list: files.list,
    dispose: files.dispose,
    refresh() {
      if (!files.refresh()) {
        return;
      }
      for (const [key, read] of reads) {
        if (read.status === "failed") {
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
      void client
        .request<WorkboardPrototypeResult>("workboard.cards.prototypes.get", {
          id: cardId,
          path: ref.path,
          ...ref.source,
        })
        .then(
          (result): HtmlState => ({ status: "loaded", html: result.html }),
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

/**
 * The drawer's Prototype tab. The host renders the prototype with its scripts
 * on the sandbox origin, apart from the Control UI's storage and DOM.
 */
export function PrototypePanel(props: {
  prototypes: CardPrototypes;
  cardId: string;
  listed: SettledList;
  active: boolean;
  revision?: number;
}) {
  const [selectedKey, setSelectedKey] = createSignal<string>();
  const loaded = () => (props.listed.status === "loaded" ? props.listed : undefined);
  const refs = createMemo(() => {
    const listed = loaded();
    return listed ? prototypeRefs(listed.result) : [];
  });
  const selected = () => refs().find((ref) => ref.key === selectedKey()) ?? refs()[0];
  const html = () => {
    void props.revision;
    const ref = selected();
    return ref && props.active ? props.prototypes.html(props.cardId, ref) : undefined;
  };
  const frameHtml = () => {
    const state = html();
    return state?.status === "loaded" ? state.html : undefined;
  };
  const popoutHref = () => {
    const ref = selected();
    return ref
      ? workboardHost().navigation.pageHref(
          prototypePageTarget({ cardId: props.cardId, source: ref.source, path: ref.path }),
        )
      : undefined;
  };
  const placeholder = () => {
    const state = html();
    return state?.status === "failed"
      ? t("workboard.prototypeFailed", { error: state.error })
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
      id="workboard-detail-panel-prototype"
      role="tabpanel"
      aria-labelledby="workboard-detail-tab-prototype"
      tabindex="0"
      hidden={!props.active}
    >
      <Show
        when={loaded()}
        fallback={
          <p class="workboard-detail__empty">
            {t("workboard.prototypesUnavailable", {
              error: props.listed.status === "unavailable" ? props.listed.error : "",
            })}
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
                  aria-label={t("workboard.prototypePick")}
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
                onClick={() => props.prototypes.refresh()}
              >
                {icons.refresh}
              </button>
            </div>
            <Show when={liveUnavailable()}>
              {(reason) => (
                <p class="workboard-screens__unavailable" role="status">
                  {t("workboard.prototypesLiveUnavailable", { reason: reason() })}
                </p>
              )}
            </Show>
            <Show when={committedUnavailable()}>
              {(reason) => (
                <p class="workboard-screens__unavailable" role="status">
                  {t("workboard.prototypesUnavailable", { error: reason() })}
                </p>
              )}
            </Show>
            <Show when={placeholder()}>
              {(text) => <p class="workboard-prototypes__placeholder">{text()}</p>}
            </Show>
            <Show when={frameHtml() !== undefined}>
              <HtmlPreview
                class="workboard-prototypes__frame"
                html={frameHtml() ?? ""}
                title={selected()?.path ?? ""}
              />
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
