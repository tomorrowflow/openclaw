import type {
  WorkboardScreenshotListResult,
  WorkboardScreenshotResult,
  WorkboardScreenshotRound,
} from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";

type ListState =
  | { status: "loading" }
  | { status: "loaded"; rounds: WorkboardScreenshotRound[] }
  | { status: "unavailable"; error: string };

type SettledList = Exclude<ListState, { status: "loading" }>;

type ImageState = { status: "loading" } | { status: "loaded"; url: string } | { status: "failed" };

// Each read returns up to ~10.7 MB of base64; three in flight stay well under
// the Gateway's 50 MB send buffer, past which it closes a slow client.
const MAX_IMAGE_READS = 3;

/** The drawer card's screenshots on one Gateway connection. */
export type CardScreenshots = {
  /** Lists the shown card's screenshots; another card or none drops the rest. */
  show(card: WorkboardCard | undefined): void;
  /** Lists the shown card again, keeping its rounds meanwhile, and retries failed images. */
  refresh(): void;
  /** Undefined hides the tab: another card, still listing, or no round committed an image. */
  list(cardId: string): SettledList | undefined;
  /** The image's state, queueing its read on first use. */
  image(cardId: string, round: WorkboardScreenshotRound, path: string): ImageState;
  dispose(): void;
};

function listKey(card: WorkboardCard): string | undefined {
  const commits = (card.rounds ?? []).flatMap((round) => (round.changes ? [round.changes.to] : []));
  return commits.length > 0 ? commits.join(",") : undefined;
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
): CardScreenshots {
  let shown: { cardId: string; key: string; list: ListState; previous?: SettledList } | undefined;
  const images = new Map<string, ImageState>();
  const queue: Array<{
    key: string;
    cardId: string;
    round: number;
    path: string;
    pending: ImageState;
  }> = [];
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
      const { key, cardId, round, path, pending } = next;
      reading += 1;
      // Started inside the chain so a throwing request still releases its slot.
      void Promise.resolve()
        .then(() =>
          client.request<WorkboardScreenshotResult>("workboard.cards.screenshots.get", {
            id: cardId,
            round,
            path,
          }),
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

  const relist = (cardId: string, key: string, previous: SettledList | undefined) => {
    const listing: NonNullable<typeof shown> = {
      cardId,
      key,
      list: { status: "loading" },
      ...(previous ? { previous } : {}),
    };
    shown = listing;
    void client
      .request<WorkboardScreenshotListResult>("workboard.cards.screenshots.list", { id: cardId })
      .then(
        (result): SettledList => ({ status: "loaded", rounds: result.rounds }),
        (error: unknown): SettledList => ({ status: "unavailable", error: formatUiError(error) }),
      )
      .then((settled) => {
        if (shown === listing) {
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
      const key = card ? listKey(card) : undefined;
      if (!card || !key) {
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
      if (!shown) {
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
      if (shown?.cardId !== cardId) {
        return undefined;
      }
      const list = settledList();
      return list?.status === "loaded" && list.rounds.length === 0 ? undefined : list;
    },
    image(cardId, round, path) {
      const key = `${round.commit}:${path}`;
      const known = images.get(key);
      if (known) {
        return known;
      }
      const pending: ImageState = { status: "loading" };
      images.set(key, pending);
      queue.push({ key, cardId, round: round.round, path, pending });
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
function groupVariants(paths: readonly string[]): Array<{ name: string; paths: string[] }> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const name = path.replace(VARIANT, "$2");
    groups.set(name, [...(groups.get(name) ?? []), path]);
  }
  return [...groups].map(([name, grouped]) => ({
    name,
    paths: grouped.length === 2 ? grouped.toSorted().toReversed() : grouped,
  }));
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function renderImage(
  screenshots: CardScreenshots,
  cardId: string,
  round: WorkboardScreenshotRound,
  path: string,
  paired: boolean,
) {
  const image = screenshots.image(cardId, round, path);
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

/** The Screenshots tab: each round's committed images, newest round first. */
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
          ? state.rounds.toReversed().map(
              (round) => html`<section class="workboard-detail__section">
                <h3>
                  ${
                    round.round === 0
                      ? t("workboard.roundFirst")
                      : t("workboard.roundRework", { number: String(round.round) })
                  }
                </h3>
                <div class="workboard-screenshots">
                  ${groupVariants(round.paths).map(
                    (group) => html`<figure class="workboard-screenshot">
                      <div class="workboard-screenshot__variants">
                        ${group.paths.map((path) =>
                          renderImage(screenshots, cardId, round, path, group.paths.length === 2),
                        )}
                      </div>
                      <figcaption title=${group.name}>${fileName(group.name)}</figcaption>
                    </figure>`,
                  )}
                </div>
              </section>`,
            )
          : nothing
    }
  </section>`;
}
