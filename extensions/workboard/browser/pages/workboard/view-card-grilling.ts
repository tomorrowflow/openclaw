import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { renderMarkdown } from "../../components/host-components.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { answerWorkboardGrill, type WorkboardCard } from "../../lib/workboard/index.ts";
import { getCardActionState } from "./view-card-actions.ts";
import { workboardMutationContext, type WorkboardProps } from "./view-helpers.ts";

// The server's cap on one answer; the textarea stops there.
const MAX_GRILL_ANSWER_CHARS = 4000;

type LogState =
  | { status: "missing" }
  | { status: "loading" }
  | { status: "loaded"; text: string }
  | { status: "failed"; error: string };

/** The drawer card's grilling log and answer draft on one Gateway connection. */
export type CardGrilling = {
  /** The card's `grilling.md`; a read starts whenever the log grew. Undefined without a grill. */
  log(card: WorkboardCard): LogState | undefined;
  draft(cardId: string): string;
  setDraft(cardId: string, text: string): void;
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
  const drafts = new Map<string, string>();
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
    draft(cardId) {
      return drafts.get(cardId) ?? "";
    },
    setDraft(cardId, text) {
      drafts.set(cardId, text);
    },
    dispose() {
      loaded = undefined;
      drafts.clear();
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
 * The Grilling tab: the question-and-answer log, and while the session waits
 * on the operator, the answer box that resumes it.
 */
export function renderGrillingPanel(
  props: WorkboardProps,
  grilling: CardGrilling,
  card: WorkboardCard,
  active: boolean,
) {
  const { busy, writable } = getCardActionState(props, card);
  const waiting = card.stage?.kind === "grilling";
  const draft = grilling.draft(card.id);
  const send = async () => {
    const answered = await answerWorkboardGrill({
      ...workboardMutationContext(props),
      cardId: card.id,
      answer: draft,
    });
    if (answered && grilling.draft(card.id) === draft) {
      grilling.setDraft(card.id, "");
      props.onRequestUpdate?.();
    }
  };
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
      active && writable && card.grill?.status === "open"
        ? html`<div class="workboard-grilling__compose">
            <textarea
              class="settings-input"
              aria-label=${t("workboard.grillingAnswerLabel")}
              rows="4"
              maxlength=${MAX_GRILL_ANSWER_CHARS}
              placeholder=${t("workboard.grillingAnswerPlaceholder")}
              .value=${draft}
              ?disabled=${busy || !waiting}
              @input=${(event: InputEvent) => {
                if (event.currentTarget instanceof HTMLTextAreaElement) {
                  grilling.setDraft(card.id, event.currentTarget.value);
                  props.onRequestUpdate?.();
                }
              }}
            ></textarea>
            ${
              waiting
                ? nothing
                : html`<p class="workboard-grilling__note">${t("workboard.grillingWorking")}</p>`
            }
            <button
              class="btn primary"
              type="button"
              ?disabled=${busy || !waiting || !draft.trim()}
              @click=${send}
            >
              ${t("workboard.grillingSend")}
            </button>
          </div>`
        : nothing
    }
  </section>`;
}
