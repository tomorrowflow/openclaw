import type {
  WorkboardCommittedScreenshots,
  WorkboardLiveScreenshot,
  WorkboardLiveScreenshots,
  WorkboardScreenshotListResult,
  WorkboardScreenshotResult,
  WorkboardScreenshotRound,
} from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isWorkboardNodeTicket } from "../../lib/workboard/execution.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";
import { listedTime } from "./view-card-time.ts";

type ListState =
  | { status: "loading" }
  // listedAt is this browser's receipt time, so "listed ago" never mixes clocks.
  | { status: "loaded"; result: WorkboardScreenshotListResult; listedAt: number }
  | { status: "unavailable"; error: string };

type SettledList = Exclude<ListState, { status: "loading" }>;

/** One image to show: a round's committed file or a live file in the node worktree. */
type ScreenshotRef =
  | { round: WorkboardScreenshotRound; path: string }
  | { live: WorkboardLiveScreenshot };

function imageKey(ref: ScreenshotRef): string {
  return "live" in ref
    ? `live:${ref.live.mtimeMs}:${ref.live.bytes}:${ref.live.path}`
    : `${ref.round.commit}:${ref.path}`;
}

function refPath(ref: ScreenshotRef): string {
  return "live" in ref ? ref.live.path : ref.path;
}

type ImageState = { status: "loading" } | { status: "loaded"; url: string } | { status: "failed" };

// Each read returns up to ~10.7 MB of base64; three in flight stay well under
// the Gateway's 50 MB send buffer, past which it closes a slow client.
const MAX_IMAGE_READS = 3;

/** One node ticket's screenshots on one Gateway connection: the drawer's tab or a session's Screens panel. */
export type CardScreenshots = {
  /** Lists the shown card's screenshots; another card or none drops the rest. */
  show(card: WorkboardCard | undefined): void;
  /**
   * Lists the shown card again, keeping its last list meanwhile, and retries
   * failed images; a no-op while the current list is loading.
   */
  refresh(): void;
  /** Undefined for another card or while the first list is pending. */
  list(cardId: string): SettledList | undefined;
  /** The image's state, queueing its read on first use. */
  image(cardId: string, ref: ScreenshotRef): ImageState;
  dispose(): void;
};

/**
 * Node tickets only; a new round's import lists again. Without live shots, a
 * card that has imported no round has nothing to list.
 */
function listKey(card: WorkboardCard, live: boolean): string | undefined {
  if (!isWorkboardNodeTicket(card)) {
    return undefined;
  }
  const key = (card.rounds ?? [])
    .flatMap((round) => (round.changes ? [round.changes.to] : []))
    .join(",");
  return key || live ? key : undefined;
}

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
  let shown: { cardId: string; key: string; list: ListState; previous?: SettledList } | undefined;
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
  const forgetStaleLive = (listed: WorkboardLiveScreenshots) => {
    const current = new Set(
      listed.state === "available" ? listed.shots.map((shot) => imageKey({ live: shot })) : [],
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

  const relist = (cardId: string, key: string, previous: SettledList | undefined) => {
    const listing: NonNullable<typeof shown> = {
      cardId,
      key,
      list: { status: "loading" },
      ...(previous ? { previous } : {}),
    };
    shown = listing;
    void client
      .request<WorkboardScreenshotListResult>("workboard.cards.screenshots.list", {
        id: cardId,
        live,
      })
      .then(
        (result): SettledList => ({ status: "loaded", result, listedAt: Date.now() }),
        (error: unknown): SettledList => ({ status: "unavailable", error: formatUiError(error) }),
      )
      .then((settled) => {
        if (shown === listing) {
          if (settled.status === "loaded" && settled.result.live) {
            forgetStaleLive(settled.result.live);
          }
          listing.list = settled;
          delete listing.previous;
          requestUpdate();
        }
      });
  };

  const settledList = () =>
    shown && (shown.list.status === "loading" ? shown.previous : shown.list);

  return {
    show(card) {
      const key = card ? listKey(card, live) : undefined;
      if (!card || key === undefined) {
        shown = undefined;
        forget();
        return;
      }
      if (shown?.cardId === card.id && shown.key === key) {
        return;
      }
      if (shown?.cardId !== card.id) {
        forget();
        relist(card.id, key, undefined);
        return;
      }
      // A new import of the same card keeps its listed rounds until the new list arrives.
      relist(card.id, key, settledList());
    },
    refresh() {
      if (!shown || shown.list.status === "loading") {
        return;
      }
      for (const [key, image] of images) {
        if (image.status === "failed") {
          images.delete(key);
        }
      }
      relist(shown.cardId, shown.key, settledList());
    },
    list(cardId) {
      return shown?.cardId === cardId ? settledList() : undefined;
    },
    image(cardId, ref) {
      const key = imageKey(ref);
      const known = images.get(key);
      if (known) {
        return known;
      }
      const pending: ImageState = { status: "loading" };
      images.set(key, pending);
      queue.push({ key, cardId, ref, pending });
      read();
      return pending;
    },
    dispose() {
      shown = undefined;
      forget();
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

function renderImage(
  screenshots: CardScreenshots,
  cardId: string,
  ref: ScreenshotRef,
  paired: boolean,
) {
  const path = refPath(ref);
  const image = screenshots.image(cardId, ref);
  const variant = paired ? VARIANT.exec(path)?.[1]?.toLowerCase() : undefined;
  const label =
    variant === "light" ? t("workboard.screenshotLight") : t("workboard.screenshotDark");
  return html`<div class="workboard-screenshot__variant">
    ${
      image.status === "loaded"
        ? html`<a href=${image.url} target="_blank" rel="noopener" title=${path}
            ><img src=${image.url} alt=${fileName(path)} loading="lazy"
          /></a>`
        : html`<span class="workboard-screenshot__placeholder"
            >${
              image.status === "failed"
                ? t("workboard.screenshotFailed")
                : t("workboard.screenshotLoading")
            }</span
          >`
    }
    ${variant ? html`<span class="workboard-screenshot__label">${label}</span>` : nothing}
  </div>`;
}

function renderFigures(
  screenshots: CardScreenshots,
  cardId: string,
  refs: readonly ScreenshotRef[],
) {
  return html`<div class="workboard-screenshots">
    ${groupVariants(refs).map(
      (group) => html`<figure class="workboard-screenshot">
        <div class="workboard-screenshot__variants">
          ${group.refs.map((ref) => renderImage(screenshots, cardId, ref, group.refs.length === 2))}
        </div>
        <figcaption title=${group.name}>${fileName(group.name)}</figcaption>
      </figure>`,
    )}
  </div>`;
}

/** Whether the drawer offers its Screenshots tab: a round committed an image, or listing failed. */
export function hasCommittedScreenshots(state: SettledList): boolean {
  return (
    state.status === "unavailable" ||
    state.result.committed.state === "unavailable" ||
    state.result.committed.rounds.length > 0
  );
}

/** Each round's committed images, newest round first. */
export function renderScreenshotRounds(
  screenshots: CardScreenshots,
  cardId: string,
  committed: WorkboardCommittedScreenshots,
) {
  return committed.state === "unavailable"
    ? html`<p class="workboard-detail__empty">
        ${t("workboard.screenshotsUnavailable", { error: committed.reason })}
      </p>`
    : committed.rounds.toReversed().map(
        (round) => html`<section class="workboard-detail__section">
          <h3>
            ${
              round.round === 0
                ? t("workboard.roundFirst")
                : t("workboard.roundRework", { number: String(round.round) })
            }
          </h3>
          ${renderFigures(
            screenshots,
            cardId,
            round.paths.map((path) => ({ round, path })),
          )}
        </section>`,
      );
}

/** The images in the node worktree right now, with when they were listed and a refresh. */
export function renderLiveScreenshots(
  screenshots: CardScreenshots,
  cardId: string,
  live: WorkboardLiveScreenshots,
  listedAt: number,
  onRefresh: () => void,
) {
  const status =
    live.state === "available"
      ? html`<span class="workboard-screens__listed">${listedTime(listedAt, Date.now())}</span>`
      : live.state === "unavailable"
        ? html`<span class="workboard-screens__unavailable" role="status"
            >${t("workboard.screensLiveUnavailable", { reason: live.reason })}</span
          >`
        : html`<span class="workboard-screens__listed">${t("workboard.screensLiveNone")}</span>`;
  return html`<section class="workboard-detail__section workboard-screens__live">
    <div class="workboard-screens__live-header">
      <h3>${t("workboard.screensLive")}</h3>
      ${status}
      <button
        type="button"
        class="btn btn--icon btn--ghost workboard-screens__refresh"
        aria-label=${t("workboard.screensRefresh")}
        title=${t("workboard.screensRefresh")}
        @click=${onRefresh}
      >
        ${icons.refresh}
      </button>
    </div>
    ${
      live.state !== "available"
        ? nothing
        : live.shots.length === 0
          ? html`<p class="workboard-detail__empty">${t("workboard.screensLiveEmpty")}</p>`
          : renderFigures(
              screenshots,
              cardId,
              live.shots.map((shot) => ({ live: shot })),
            )
    }
  </section>`;
}

/** The drawer's Screenshots tab: each round's committed images. */
export function renderScreenshotsPanel(
  screenshots: CardScreenshots,
  cardId: string,
  state: SettledList,
  active: boolean,
) {
  return html`<section
    class="workboard-detail__tabpanel workboard-detail__screenshots"
    id="workboard-detail-panel-screenshots"
    role="tabpanel"
    aria-labelledby="workboard-detail-tab-screenshots"
    tabindex="0"
    ?hidden=${!active}
  >
    ${
      state.status === "unavailable"
        ? html`<p class="workboard-detail__empty">
            ${t("workboard.screenshotsUnavailable", { error: state.error })}
          </p>`
        : active
          ? renderScreenshotRounds(screenshots, cardId, state.result.committed)
          : nothing
    }
  </section>`;
}
