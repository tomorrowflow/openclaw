import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { renderMarkdown } from "../../components/host-components.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { endWorkboardGrill, type WorkboardCard } from "../../lib/workboard/index.ts";
import { getCardActionState } from "./view-card-actions.ts";
import { workboardMutationContext, type WorkboardProps } from "./view-helpers.ts";

type LogState =
  | { status: "missing" }
  | { status: "loading" }
  | { status: "loaded"; text: string }
  | { status: "failed"; error: string };

/** The drawer card's grilling log on one Gateway connection. */
export type CardGrilling = {
  /** The card's `grilling.md`; a read starts whenever the log grew. Undefined without a grill. */
  log(card: WorkboardCard): LogState | undefined;
  dispose(): void;
};

function decodeBase64Utf8(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

/** The log only grows, so its byte size names a version of it. */
function logVersion(card: WorkboardCard): string | undefined {
  const attachmentId = card.grill?.attachmentId;
  const attachment = card.metadata?.attachments?.find((entry) => entry.id === attachmentId);
  return attachment ? `${attachment.id}:${attachment.byteSize}` : undefined;
}

/** Created per connection, so a reconnect reads afresh. */
export function createCardGrilling(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): CardGrilling {
  let loaded: { version: string; state: LogState } | undefined;
  return {
    log(card) {
      const attachmentId = card.grill?.attachmentId;
      if (!attachmentId) {
        return undefined;
      }
      const version = logVersion(card);
      if (!version) {
        return { status: "missing" };
      }
      if (loaded?.version === version) {
        return loaded.state;
      }
      const pending = { version, state: { status: "loading" } as LogState };
      loaded = pending;
      void Promise.resolve()
        .then(() =>
          client.request<{ contentBase64: string }>("workboard.cards.attachments.get", {
            id: attachmentId,
          }),
        )
        .then(
          (result): LogState => ({
            status: "loaded",
            text: decodeBase64Utf8(result.contentBase64),
          }),
          (error: unknown): LogState => ({ status: "failed", error: formatUiError(error) }),
        )
        .then((state) => {
          if (loaded === pending) {
            loaded = { version, state };
            requestUpdate();
          }
        });
      return pending.state;
    },
    dispose() {
      loaded = undefined;
    },
  };
}

function renderLog(state: LogState | undefined) {
  if (!state || state.status === "missing") {
    return html`<p class="workboard-grilling__note">${t("workboard.grillingMissing")}</p>`;
  }
  if (state.status === "loading") {
    return html`<p class="workboard-grilling__note">${t("workboard.grillingLoading")}</p>`;
  }
  if (state.status === "failed") {
    return html`<p class="workboard-grilling__note">
      ${t("workboard.grillingLoadFailed", { error: state.error })}
    </p>`;
  }
  return html`<div class="workboard-grilling__log">${renderMarkdown(state.text)}</div>`;
}

/**
 * The Grilling tab: the log of the grilling, and while it is live, the way to
 * the card's session chat where it happens and End grilling. End grilling
 * waits while the session replies, so the resumed round's start does not
 * race that reply.
 */
export function renderGrillingPanel(
  props: WorkboardProps,
  grilling: CardGrilling,
  card: WorkboardCard,
  active: boolean,
) {
  const { busy, live, sessionTarget, writable } = getCardActionState(props, card);
  const waiting = card.stage?.kind === "grilling";
  return html`<section
    class="workboard-detail__tabpanel workboard-grilling"
    id="workboard-detail-panel-grilling"
    role="tabpanel"
    aria-labelledby="workboard-detail-tab-grilling"
    tabindex="0"
    ?hidden=${!active}
  >
    ${active ? renderLog(grilling.log(card)) : nothing}
    ${
      active && waiting
        ? html`<p class="workboard-grilling__note">${t("workboard.grillingChatNote")}</p>
            <div class="workboard-grilling__actions">
              ${
                writable
                  ? html`<button
                      class="btn"
                      type="button"
                      data-grilling-action="end"
                      title=${live ? t("workboard.grillingEndReplying") : t("workboard.grillingEndTitle")}
                      ?disabled=${busy || live}
                      @click=${() =>
                        void endWorkboardGrill({
                          ...workboardMutationContext(props),
                          cardId: card.id,
                        })}
                    >
                      ${t("workboard.grillingEnd")}
                    </button>`
                  : nothing
              }
              ${
                sessionTarget
                  ? html`<button
                      class="btn primary"
                      type="button"
                      data-grilling-action="chat"
                      @click=${() => props.onOpenSession(sessionTarget)}
                    >
                      ${t("workboard.grillingOpenChat")}
                    </button>`
                  : nothing
              }
            </div>`
        : nothing
    }
  </section>`;
}
