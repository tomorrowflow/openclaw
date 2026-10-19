/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { Markdown } from "../../components/host-components.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  endWorkboardGrill,
  workboardGrillSessionName,
  type WorkboardCard,
} from "../../lib/workboard/index.ts";
import { getCardActionState } from "./view-card-actions.tsx";
import { workboardMutationContext, type WorkboardProps } from "./view-helpers.tsx";

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
      const pending: { version: string; state: LogState } = {
        version,
        state: { status: "loading" },
      };
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

function GrillingLog(props: { state: LogState | undefined }) {
  const note = () => {
    const state = props.state;
    if (!state || state.status === "missing") {
      return t("workboard.grillingMissing");
    }
    if (state.status === "loading") {
      return t("workboard.grillingLoading");
    }
    return state.status === "failed"
      ? t("workboard.grillingLoadFailed", { error: state.error })
      : undefined;
  };
  const text = () => (props.state?.status === "loaded" ? props.state.text : undefined);
  return (
    <Show when={text() !== undefined} fallback={<p class="workboard-grilling__note">{note()}</p>}>
      <div class="workboard-grilling__log">
        <Markdown markdown={text() ?? ""} />
      </div>
    </Show>
  );
}

/**
 * The Grilling tab: the log of each handoff and result, and while the
 * grilling waits on the operator, the way into its grill session and End
 * grilling, which the server refuses while the grill session replies.
 */
export function GrillingPanel(props: {
  workboard: WorkboardProps;
  grilling: CardGrilling;
  card: WorkboardCard;
  active: boolean;
  revision?: number;
}) {
  const card = () => {
    void props.revision;
    return props.card;
  };
  const action = () => getCardActionState(props.workboard, card());
  const sessionKey = () => card().grill?.sessionKey;
  return (
    <section
      class="workboard-detail__tabpanel workboard-grilling"
      id="workboard-detail-panel-grilling"
      role="tabpanel"
      aria-labelledby="workboard-detail-tab-grilling"
      tabindex="0"
      hidden={!props.active}
    >
      <Show when={props.active}>
        <GrillingLog state={props.grilling.log(card())} />
      </Show>
      <Show when={props.active && card().stage?.kind === "grilling"}>
        <p class="workboard-grilling__note">
          {sessionKey()
            ? t("workboard.grillingSessionNote", { name: workboardGrillSessionName(card()) })
            : t("workboard.grillingStarting")}
        </p>
        <div class="workboard-grilling__actions">
          <Show when={action().writable}>
            <button
              class="btn"
              type="button"
              data-grilling-action="end"
              title={t("workboard.grillingEndTitle")}
              disabled={action().busy}
              onClick={() =>
                void endWorkboardGrill({
                  ...workboardMutationContext(props.workboard),
                  cardId: card().id,
                })
              }
            >
              {t("workboard.grillingEnd")}
            </button>
          </Show>
          <Show when={sessionKey()}>
            {(key) => (
              <button
                class="btn primary"
                type="button"
                data-grilling-action="session"
                onClick={() => props.workboard.onOpenSession({ sessionKey: key() })}
              >
                {t("workboard.grillingOpenSession")}
              </button>
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
}
