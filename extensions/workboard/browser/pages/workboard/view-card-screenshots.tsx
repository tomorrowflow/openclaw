/** @jsxImportSource @solidjs/web */
import type {
  WorkboardCommittedNodeFiles,
  WorkboardLiveNodeFile,
  WorkboardLiveNodeFiles,
  WorkboardNodeFileRound,
  WorkboardScreenshotResult,
} from "@openclaw/workboard-contract";
import { For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { type CardFileList, createCardFileList, type SettledList } from "./card-node-files.ts";
import { RelativeTime } from "./view-card-time.tsx";

/**
 * One image to show: a round's committed file or a live file in the node
 * worktree. `ownerId` is the linked card a committed file belongs to; absent
 * for the shown card's own files.
 */
type ScreenshotRef =
  | { round: WorkboardNodeFileRound; path: string; ownerId?: string }
  | { live: WorkboardLiveNodeFile };

function imageKey(ref: ScreenshotRef): string {
  if ("live" in ref) {
    return `live:${ref.live.mtimeMs}:${ref.live.bytes}:${ref.live.path}`;
  }
  return `${ref.ownerId ? `linked:${ref.ownerId}:` : ""}${ref.round.commit}:${ref.path}`;
}

function refPath(ref: ScreenshotRef): string {
  return "live" in ref ? ref.live.path : ref.path;
}

type ImageState = { status: "loading" } | { status: "loaded"; url: string } | { status: "failed" };

// Each read returns up to ~10.7 MB of base64; three in flight stay well under
// the Gateway's 50 MB send buffer, past which it closes a slow client.
const MAX_IMAGE_READS = 3;

/** One node ticket's screenshots on one Gateway connection: the drawer's tab or a session's Screens panel. */
export type CardScreenshots = Omit<CardFileList, "refresh"> & {
  /** Lists the shown card again and retries failed images; a no-op while the current list is loading. */
  refresh(): void;
  /** The image's state, queueing its read on first use. */
  image(cardId: string, ref: ScreenshotRef): ImageState;
  dispose(): void;
};

function objectUrl(result: WorkboardScreenshotResult): string {
  const bytes = Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
}

/**
 * Created per connection, so a reconnect lists and reads afresh; nothing it
 * learned on the previous connection, failures included, carries over.
 */
export function createCardScreenshots(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
  { live }: { live: boolean },
): CardScreenshots {
  const images = new Map<string, ImageState>();
  const queue: Array<{ key: string; cardId: string; ref: ScreenshotRef; pending: ImageState }> = [];
  let reading = 0;

  const forget = () => {
    for (const image of images.values()) {
      if (image.status === "loaded") {
        URL.revokeObjectURL(image.url);
      }
    }
    images.clear();
    queue.length = 0;
  };

  const read = () => {
    for (let next; reading < MAX_IMAGE_READS && (next = queue.shift());) {
      const { key, cardId, ref, pending } = next;
      reading += 1;
      // Started inside the chain so a throwing request still releases its slot.
      void Promise.resolve()
        .then(() =>
          client.request<WorkboardScreenshotResult>(
            "workboard.cards.screenshots.get",
            "live" in ref
              ? { id: cardId, live: true, path: ref.live.path }
              : { id: cardId, round: ref.round.round, path: ref.path },
          ),
        )
        .then((result): ImageState => ({ status: "loaded", url: objectUrl(result) }))
        .catch((): ImageState => ({ status: "failed" }))
        .then((settled) => {
          reading -= 1;
          // A forgotten read (drawer closed, card switched) no longer owns its key.
          if (images.get(key) === pending) {
            images.set(key, settled);
            requestUpdate();
          } else if (settled.status === "loaded") {
            URL.revokeObjectURL(settled.url);
          }
          read();
        });
    }
  };

  /** A live file rewritten or removed since the last list will not be shown again. */
  const forgetStaleLive = (listed: WorkboardLiveNodeFiles) => {
    const current = new Set(
      listed.state === "available" ? listed.files.map((shot) => imageKey({ live: shot })) : [],
    );
    for (const [key, image] of images) {
      if (key.startsWith("live:") && !current.has(key)) {
        if (image.status === "loaded") {
          URL.revokeObjectURL(image.url);
        }
        images.delete(key);
      }
    }
  };

  const files = createCardFileList(client, requestUpdate, {
    method: "workboard.cards.screenshots.list",
    live,
    onForget: forget,
    onListed: (result) => result.live && forgetStaleLive(result.live),
  });

  return {
    show: files.show,
    list: files.list,
    dispose: files.dispose,
    refresh() {
      if (!files.refresh()) {
        return;
      }
      for (const [key, image] of images) {
        if (image.status === "failed") {
          images.delete(key);
        }
      }
    },
    image(cardId, ref) {
      const key = imageKey(ref);
      const owner = "live" in ref ? cardId : (ref.ownerId ?? cardId);
      const known = images.get(key);
      if (known) {
        return known;
      }
      const pending: ImageState = { status: "loading" };
      images.set(key, pending);
      queue.push({ key, cardId: owner, ref, pending });
      read();
      return pending;
    },
  };
}

const VARIANT = /-(light|dark)(\.[a-z]+)$/i;

/** Light and dark captures of one state share a figure, light first. */
function groupVariants(
  refs: readonly ScreenshotRef[],
): Array<{ name: string; refs: ScreenshotRef[] }> {
  const groups = new Map<string, ScreenshotRef[]>();
  for (const ref of refs) {
    const name = refPath(ref).replace(VARIANT, "$2");
    groups.set(name, [...(groups.get(name) ?? []), ref]);
  }
  return [...groups].map(([name, grouped]) => ({
    name,
    refs:
      grouped.length === 2
        ? grouped.toSorted((left, right) => (refPath(left) < refPath(right) ? 1 : -1))
        : grouped,
  }));
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Props shared by the screenshot views; `revision` re-reads the controller after it updates. */
type ScreenshotsView = { screenshots: CardScreenshots; cardId: string; revision?: number };

function ScreenshotImage(props: ScreenshotsView & { shot: ScreenshotRef; paired: boolean }) {
  const path = () => refPath(props.shot);
  const image = () => {
    void props.revision;
    return props.screenshots.image(props.cardId, props.shot);
  };
  const variant = () => (props.paired ? VARIANT.exec(path())?.[1]?.toLowerCase() : undefined);
  const loadedUrl = () => {
    const current = image();
    return current.status === "loaded" ? current.url : undefined;
  };
  return (
    <div class="workboard-screenshot__variant">
      <Show
        when={loadedUrl()}
        fallback={
          <span class="workboard-screenshot__placeholder">
            {image().status === "failed"
              ? t("workboard.screenshotFailed")
              : t("workboard.screenshotLoading")}
          </span>
        }
      >
        {(url) => (
          <a href={url()} target="_blank" rel="noopener" title={path()}>
            <img src={url()} alt={fileName(path())} loading="lazy" />
          </a>
        )}
      </Show>
      <Show when={variant()}>
        {(shown) => (
          <span class="workboard-screenshot__label">
            {shown() === "light" ? t("workboard.screenshotLight") : t("workboard.screenshotDark")}
          </span>
        )}
      </Show>
    </div>
  );
}

function ScreenshotFigures(props: ScreenshotsView & { refs: readonly ScreenshotRef[] }) {
  return (
    <div class="workboard-screenshots">
      <For each={groupVariants(props.refs)} keyed={(group) => group.name}>
        {(group) => (
          <figure class="workboard-screenshot">
            <div class="workboard-screenshot__variants">
              <For each={group().refs} keyed={imageKey}>
                {(shot) => (
                  <ScreenshotImage
                    screenshots={props.screenshots}
                    cardId={props.cardId}
                    revision={props.revision}
                    shot={shot()}
                    paired={group().refs.length === 2}
                  />
                )}
              </For>
            </div>
            <figcaption title={group().name}>{fileName(group().name)}</figcaption>
          </figure>
        )}
      </For>
    </div>
  );
}

/** Whether the drawer offers its Screenshots tab: a round committed an image, or listing failed. */
export function hasCommittedScreenshots(state: SettledList): boolean {
  return (
    state.status === "unavailable" ||
    state.result.committed.state === "unavailable" ||
    state.result.committed.rounds.length > 0 ||
    (state.result.linked?.length ?? 0) > 0
  );
}

/**
 * Each round's committed images, newest round first. `from` names the linked
 * card whose rounds these are; omitted for the shown card's own.
 */
export function ScreenshotRounds(
  props: ScreenshotsView & {
    committed: WorkboardCommittedNodeFiles;
    from?: { cardId: string; title: string };
  },
) {
  const rounds = () =>
    props.committed.state === "available" ? props.committed.rounds.toReversed() : undefined;
  return (
    <Show
      when={rounds()}
      fallback={
        <p class="workboard-detail__empty">
          {t("workboard.screenshotsUnavailable", {
            error: props.committed.state === "unavailable" ? props.committed.reason : "",
          })}
        </p>
      }
    >
      {(available) => (
        <For each={available()} keyed={(round) => `${round.round}:${round.commit}`}>
          {(round) => (
            <section class="workboard-detail__section">
              <h3>
                {props.from ? `${t("workboard.linkedFrom", { title: props.from.title })} · ` : ""}
                {round().round === 0
                  ? t("workboard.roundFirst")
                  : t("workboard.roundRework", { number: String(round().round) })}
              </h3>
              <ScreenshotFigures
                screenshots={props.screenshots}
                cardId={props.cardId}
                revision={props.revision}
                refs={round().paths.map((path): ScreenshotRef =>
                  props.from
                    ? { round: round(), path, ownerId: props.from.cardId }
                    : { round: round(), path },
                )}
              />
            </section>
          )}
        </For>
      )}
    </Show>
  );
}

/** The images in the node worktree right now, with when they were listed and a refresh. */
export function LiveScreenshots(
  props: ScreenshotsView & {
    live: WorkboardLiveNodeFiles;
    listedAt: number;
    onRefresh: () => void;
  },
) {
  const shots = () => (props.live.state === "available" ? props.live.files : undefined);
  return (
    <section class="workboard-detail__section workboard-screens__live">
      <div class="workboard-screens__live-header">
        <h3>{t("workboard.screensLive")}</h3>
        {props.live.state === "available" ? (
          <span class="workboard-screens__listed">
            <RelativeTime timestamp={props.listedAt} now={Date.now()} format="listed" />
          </span>
        ) : props.live.state === "unavailable" ? (
          <span class="workboard-screens__unavailable" role="status">
            {t("workboard.screensLiveUnavailable", { reason: props.live.reason })}
          </span>
        ) : (
          <span class="workboard-screens__listed">{t("workboard.screensLiveNone")}</span>
        )}
        <button
          type="button"
          class="btn btn--icon btn--ghost workboard-screens__refresh"
          aria-label={t("workboard.screensRefresh")}
          title={t("workboard.screensRefresh")}
          onClick={() => props.onRefresh()}
        >
          {icons.refresh}
        </button>
      </div>
      <Show when={shots()}>
        {(available) => (
          <Show
            when={available().length > 0}
            fallback={<p class="workboard-detail__empty">{t("workboard.screensLiveEmpty")}</p>}
          >
            <ScreenshotFigures
              screenshots={props.screenshots}
              cardId={props.cardId}
              revision={props.revision}
              refs={available().map((shot) => ({ live: shot }))}
            />
          </Show>
        )}
      </Show>
    </section>
  );
}

/** The drawer's Screenshots tab: each round's committed images, then those of linked cards. */
export function ScreenshotsPanel(
  props: ScreenshotsView & { listed: SettledList; active: boolean },
) {
  const loaded = () => (props.listed.status === "loaded" ? props.listed.result : undefined);
  return (
    <section
      class="workboard-detail__tabpanel workboard-detail__screenshots"
      id="workboard-detail-panel-screenshots"
      role="tabpanel"
      aria-labelledby="workboard-detail-tab-screenshots"
      tabindex="0"
      hidden={!props.active}
    >
      <Show
        when={loaded()}
        fallback={
          <p class="workboard-detail__empty">
            {t("workboard.screenshotsUnavailable", {
              error: props.listed.status === "unavailable" ? props.listed.error : "",
            })}
          </p>
        }
      >
        {(result) => (
          <Show when={props.active}>
            <ScreenshotRounds
              screenshots={props.screenshots}
              cardId={props.cardId}
              revision={props.revision}
              committed={result().committed}
            />
            <For each={result().linked ?? []} keyed={(entry) => entry.cardId}>
              {(entry) => (
                <ScreenshotRounds
                  screenshots={props.screenshots}
                  cardId={props.cardId}
                  revision={props.revision}
                  committed={entry().committed}
                  from={{ cardId: entry().cardId, title: entry().title }}
                />
              )}
            </For>
          </Show>
        )}
      </Show>
    </section>
  );
}
