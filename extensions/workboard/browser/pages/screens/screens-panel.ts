import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { html, nothing, render } from "lit";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { t } from "../../i18n/index.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";
import { isWorkboardNodeTicket } from "../../lib/workboard/execution.ts";
import { findWorkboardSessionCard } from "../../lib/workboard/session-links.ts";
import {
  createCardScreenshots,
  renderLiveScreenshots,
  renderScreenshotRounds,
  type CardScreenshots,
} from "../workboard/view-card-screenshots.ts";

const LIVE_REFRESH_MS = 20_000;

/**
 * A session's Screens panel: the screenshots its node ticket's agent has
 * written so far, then each round's committed ones. It lists again every
 * 20 seconds only while it is shown and the ticket runs.
 */
export function createScreensPanel(workboard: WorkboardCapability): ControlUiView<BoardGetParams> {
  return (container, initialContext) => {
    let context = initialContext;
    const host = context.host;
    let connected = false;
    let screenshots: CardScreenshots | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const stopPolling = () => {
      clearInterval(poll);
      poll = undefined;
    };

    const draw = () => {
      if (connected !== host.connection.connected) {
        connected = host.connection.connected;
        screenshots?.dispose();
        screenshots = connected ? createCardScreenshots(host, draw) : undefined;
      }
      const sessionCard =
        context.presented && screenshots
          ? findWorkboardSessionCard(workboard.state.cards, context.props.sessionKey)
          : null;
      const card = sessionCard && isWorkboardNodeTicket(sessionCard) ? sessionCard : undefined;
      screenshots?.show(card);
      if (!card || card.status !== "running") {
        stopPolling();
      } else if (!poll) {
        poll = setInterval(() => screenshots?.refresh(), LIVE_REFRESH_MS);
      }
      const list = card && screenshots?.list(card.id);
      render(
        !screenshots || !context.presented
          ? nothing
          : html`<div class="workboard-screens">
              ${
                !card
                  ? html`<p class="workboard-detail__empty">${t("workboard.screensNoCard")}</p>`
                  : !list
                    ? html`<p class="workboard-detail__empty" role="status">
                        ${t("workboard.screenshotLoading")}
                      </p>`
                    : list.status === "unavailable"
                      ? html`<p class="workboard-detail__empty">
                          ${t("workboard.screenshotsUnavailable", { error: list.error })}
                        </p>`
                      : html`${renderLiveScreenshots(screenshots, card.id, list.result.live, () =>
                            screenshots?.refresh(),
                          )}
                          <h3 class="workboard-screens__heading">
                            ${t("workboard.screensCommitted")}
                          </h3>
                          ${
                            list.result.committed.state === "available" &&
                            list.result.committed.rounds.length === 0
                              ? html`<p class="workboard-detail__empty">
                                  ${t("workboard.screensCommittedEmpty")}
                                </p>`
                              : renderScreenshotRounds(screenshots, card.id, list.result.committed)
                          }`
              }
            </div>`,
        container,
      );
    };

    const stopHost = host.subscribe(draw);
    const stopState = workboard.subscribe(draw);
    draw();
    return {
      update(next) {
        context = next;
        draw();
      },
      dispose() {
        stopPolling();
        stopHost();
        stopState();
        screenshots?.dispose();
        render(nothing, container);
      },
    };
  };
}
