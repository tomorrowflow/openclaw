import { html, nothing, render } from "lit";
import type {
  ControlUiDisposer,
  ControlUiReplacement,
  ControlUiViewContext,
  ControlUiSurfaceProps,
} from "openclaw/plugin-sdk/control-ui";
import { t } from "./i18n/index.ts";
import { formatUiError } from "./lib/format-error.ts";
import type { WorkboardCapability } from "./lib/workboard/capability.ts";
import { findWorkboardSession, workboardCardRunIsLive } from "./lib/workboard/lifecycle.ts";
import { findWorkboardSessionCard } from "./lib/workboard/session-links.ts";
import type { WorkboardCard } from "./lib/workboard/types.ts";

type ComposerContext = ControlUiViewContext<ControlUiSurfaceProps["composer"]>;

/**
 * The chat composer of a node ticket session while its card is grilling. The
 * host shows a subagent session read-only and its composer's send refuses
 * one, but the Gateway accepts the session's turns, and a grilling happens
 * there, so this box sends with `chat.send` itself; the transcript shows the
 * turn from the session's events. Every other session, and any failure here,
 * gets the host's own composer.
 */
export function createWorkboardGrillingComposer(
  workboard: WorkboardCapability,
): ControlUiReplacement<"composer">["mount"] {
  return (container, initialContext) => {
    let context: ComposerContext = initialContext;
    let disposeDefault: ControlUiDisposer | undefined;
    const defaultRoot = document.createElement("div");
    const grillingRoot = document.createElement("div");
    defaultRoot.style.display = "contents";
    grillingRoot.style.display = "contents";
    container.append(grillingRoot, defaultRoot);

    let sending = false;
    let disposed = false;
    let sendError = "";

    const showDefault = () => {
      render(nothing, grillingRoot);
      disposeDefault ??= context.mountDefault(defaultRoot);
    };
    const grillingCard = () => {
      const card = context.presented
        ? findWorkboardSessionCard(workboard.state.cards, context.props.sessionKey)
        : null;
      return card?.stage?.kind === "grilling" ? card : null;
    };
    // A turn sent while the agent still answers the last one can find the
    // grilling ended by that answer, and nothing would record it.
    const agentReplying = (card: WorkboardCard) =>
      workboardCardRunIsLive(card, findWorkboardSession(card, context.host.sessions.rows));
    // The box's own text: the host's draft prop lags a keystroke behind it.
    const send = async (text: string | undefined) => {
      const { props, host } = context;
      const message = text?.trim() ?? "";
      const card = grillingCard();
      if (sending || !message || !card || agentReplying(card)) {
        return;
      }
      sending = true;
      sendError = "";
      draw();
      const sent = await host
        .request("chat.send", {
          sessionKey: props.sessionKey,
          message,
          idempotencyKey: crypto.randomUUID(),
        })
        .then(
          () => true,
          (error: unknown) => {
            sendError = formatUiError(error, t("workboard.grillingComposerFailed"));
            return false;
          },
        );
      sending = false;
      if (disposed) {
        return;
      }
      const box = grillingRoot.querySelector("textarea");
      if (sent && box?.value.trim() === message) {
        box.value = "";
        try {
          context.props.setDraft("");
        } catch {
          // The view ended; the next mount reads the host's draft.
        }
      }
      draw();
    };
    const draw = () => {
      try {
        const card = grillingCard();
        if (!card) {
          showDefault();
          return;
        }
        const replying = agentReplying(card);
        disposeDefault?.();
        disposeDefault = undefined;
        const { props, host } = context;
        const writable = host.connection.connected && host.connection.canWrite;
        render(
          html`<div class="workboard-grill-composer">
            <p class="workboard-grill-composer__hint">${t("workboard.grillingComposerHint")}</p>
            <div class="workboard-grill-composer__row">
              <textarea
                class="workboard-grill-composer__input"
                rows="3"
                aria-label=${t("workboard.grillingComposerLabel")}
                placeholder=${t("workboard.grillingComposerPlaceholder")}
                .value=${props.draft}
                ?disabled=${!writable}
                @input=${(event: InputEvent) => {
                  if (event.currentTarget instanceof HTMLTextAreaElement) {
                    try {
                      context.props.setDraft(event.currentTarget.value);
                    } catch {
                      // The view ended; the next mount reads the host's draft.
                    }
                  }
                }}
                @keydown=${(event: KeyboardEvent) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.isComposing &&
                    event.currentTarget instanceof HTMLTextAreaElement
                  ) {
                    event.preventDefault();
                    void send(event.currentTarget.value);
                  }
                }}
              ></textarea>
              <button
                class="btn primary"
                type="button"
                ?disabled=${!writable || sending || replying || !props.draft.trim()}
                @click=${() => void send(grillingRoot.querySelector("textarea")?.value)}
              >
                ${t("workboard.grillingComposerSend")}
              </button>
            </div>
            ${
              replying
                ? html`<p class="workboard-grill-composer__hint" role="status">
                    ${t("workboard.grillingComposerReplying")}
                  </p>`
                : nothing
            }
            ${sendError ? html`<p class="workboard-grill-composer__error" role="alert">${sendError}</p>` : nothing}
          </div>`,
          grillingRoot,
        );
      } catch {
        // Composing must keep working: anything this view cannot do falls back to the host's.
        showDefault();
      }
    };
    const stopHost = initialContext.host.subscribe(draw);
    const stopState = workboard.subscribe(draw);
    draw();
    return {
      update(next) {
        context = next;
        draw();
      },
      dispose() {
        disposed = true;
        stopHost();
        stopState();
        disposeDefault?.();
        disposeDefault = undefined;
        render(nothing, grillingRoot);
        container.replaceChildren();
      },
    };
  };
}
