import type {
  WorkboardScreenshotListResult,
  WorkboardScreenshotResult,
  WorkboardScreenshotRound,
} from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";
import type { WorkboardProps } from "./view-helpers.ts";

type ListState = { key: string } & (
  | { status: "loading" }
  | { status: "loaded"; rounds: WorkboardScreenshotRound[] }
  | { status: "unavailable"; error: string }
);

type ImageState = { status: "loading" } | { status: "loaded"; url: string } | { status: "failed" };

// The drawer shows one card at a time, so the cache holds one card's
// screenshots; opening another card revokes the previous object URLs.
let list: (ListState & { cardId: string }) | undefined;
const images = new Map<string, ImageState>();

function listKey(card: WorkboardCard): string | undefined {
  const commits = (card.rounds ?? []).flatMap((round) => (round.changes ? [round.changes.to] : []));
  return commits.length > 0 ? `${card.id}:${commits.join(",")}` : undefined;
}

function forgetImages() {
  for (const image of images.values()) {
    if (image.status === "loaded") {
      URL.revokeObjectURL(image.url);
    }
  }
  images.clear();
}

/**
 * The card's screenshot rounds once listed; starts the listing for a node
 * ticket with imported rounds. Undefined hides the tab: no imported round,
 * still listing, or no round committed an image.
 */
export function loadedCardScreenshots(
  props: WorkboardProps,
  card: WorkboardCard,
): ListState | undefined {
  const key = listKey(card);
  if (!key || !props.client) {
    return undefined;
  }
  if (list?.key !== key) {
    if (list?.cardId !== card.id) {
      forgetImages();
    }
    const requested: ListState & { cardId: string } = { key, cardId: card.id, status: "loading" };
    list = requested;
    void props.client
      .request<WorkboardScreenshotListResult>("workboard.cards.screenshots.list", { id: card.id })
      .then(
        (result): ListState => ({ key, status: "loaded", rounds: result.rounds }),
        (error: unknown): ListState => ({
          key,
          status: "unavailable",
          error: formatUiError(error),
        }),
      )
      .then((settled) => {
        if (list === requested) {
          list = { ...settled, cardId: card.id };
          props.onRequestUpdate?.();
        }
      });
  }
  if (list.status === "loading" || (list.status === "loaded" && list.rounds.length === 0)) {
    return undefined;
  }
  return list;
}

function imageKey(round: WorkboardScreenshotRound, path: string): string {
  return `${round.commit}:${path}`;
}

function loadImage(
  props: WorkboardProps,
  card: WorkboardCard,
  round: WorkboardScreenshotRound,
  path: string,
) {
  const key = imageKey(round, path);
  if (images.has(key) || !props.client) {
    return;
  }
  images.set(key, { status: "loading" });
  void props.client
    .request<WorkboardScreenshotResult>("workboard.cards.screenshots.get", {
      id: card.id,
      round: round.round,
      path,
    })
    .then(
      (result): ImageState => {
        const bytes = Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0));
        return {
          status: "loaded",
          url: URL.createObjectURL(new Blob([bytes], { type: result.mimeType })),
        };
      },
      (): ImageState => ({ status: "failed" }),
    )
    .then((settled) => {
      // A newer card's listing cleared the cache; this image belongs to no shown card.
      if (images.get(key)?.status !== "loading") {
        if (settled.status === "loaded") {
          URL.revokeObjectURL(settled.url);
        }
        return;
      }
      images.set(key, settled);
      props.onRequestUpdate?.();
    });
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
  props: WorkboardProps,
  card: WorkboardCard,
  round: WorkboardScreenshotRound,
  path: string,
  paired: boolean,
) {
  loadImage(props, card, round, path);
  const image = images.get(imageKey(round, path));
  const variant = paired ? VARIANT.exec(path)?.[1]?.toLowerCase() : undefined;
  const label =
    variant === "light" ? t("workboard.screenshotLight") : t("workboard.screenshotDark");
  return html`<div class="workboard-screenshot__variant">
    ${
      image?.status === "loaded"
        ? html`<a href=${image.url} target="_blank" rel="noopener" title=${path}
            ><img src=${image.url} alt=${fileName(path)} loading="lazy"
          /></a>`
        : html`<span class="workboard-screenshot__placeholder"
            >${
              image?.status === "failed"
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
  props: WorkboardProps,
  card: WorkboardCard,
  state: ListState,
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
        : active && state.status === "loaded"
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
                          renderImage(props, card, round, path, group.paths.length === 2),
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
