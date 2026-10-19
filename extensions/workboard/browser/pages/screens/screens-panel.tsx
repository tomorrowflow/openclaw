/** @jsxImportSource @solidjs/web */
import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type { WorkboardCommittedScreenshots } from "@openclaw/workboard-contract";
import { render } from "@solidjs/web";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";
import { isWorkboardNodeTicket } from "../../lib/workboard/execution.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";
import { normalizeCardsPayload } from "../../lib/workboard/normalization.ts";
import { findWorkboardSessionCard } from "../../lib/workboard/session-links.ts";
import {
  createCardScreenshots,
  LiveScreenshots,
  ScreenshotRounds,
  type CardScreenshots,
} from "../workboard/view-card-screenshots.tsx";

function hasNoCommittedRounds(committed: WorkboardCommittedScreenshots): boolean {
  return committed.state === "available" && committed.rounds.length === 0;
}

const LIVE_REFRESH_MS = 20_000;

type Presentation = {
  screenshots: CardScreenshots;
  card: WorkboardCard | undefined;
  revision: number;
};

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
    let revision = 0;
    const [presentation, setPresentation] = createSignal<Presentation>();
    // The board fills workboard.state.cards only once the Workboard page has
    // loaded; a session opened directly reads its own card instead.
    let sessionCards: { key: string; cards: WorkboardCard[] } | undefined;
    let sessionLoad: string | undefined;
    const loadSessionCards = (key: string) => {
      if (sessionLoad === key) {
        return;
      }
      sessionLoad = key;
      void host
        .request("workboard.cards.list", { sessionKey: key })
        .then(
          (payload) => {
            if (sessionLoad === key) {
              sessionCards = { key, cards: normalizeCardsPayload(payload).cards };
            }
          },
          () => undefined,
        )
        .finally(() => {
          if (sessionLoad === key) {
            sessionLoad = undefined;
            draw();
          }
        });
    };

    const stopPolling = () => {
      clearInterval(poll);
      poll = undefined;
    };

    const draw = () => {
      if (connected !== host.connection.connected) {
        connected = host.connection.connected;
        screenshots?.dispose();
        screenshots = connected ? createCardScreenshots(host, draw, { live: true }) : undefined;
      }
      const sessionKey = context.props.sessionKey;
      let sessionCard =
        context.presented && screenshots
          ? findWorkboardSessionCard(workboard.state.cards, sessionKey)
          : null;
      if (context.presented && screenshots && !sessionCard && sessionKey) {
        if (sessionCards?.key === sessionKey) {
          sessionCard = findWorkboardSessionCard(sessionCards.cards, sessionKey);
        } else {
          loadSessionCards(sessionKey);
        }
      }
      const card = sessionCard && isWorkboardNodeTicket(sessionCard) ? sessionCard : undefined;
      screenshots?.show(card);
      if (!card || card.status !== "running") {
        stopPolling();
      } else if (!poll) {
        poll = setInterval(() => {
          screenshots?.refresh();
          if (sessionCards && sessionKey) {
            // Without the board, only this re-read notices the ticket stop running.
            loadSessionCards(sessionKey);
          }
        }, LIVE_REFRESH_MS);
      }
      setPresentation(
        screenshots && context.presented ? { screenshots, card, revision: ++revision } : undefined,
      );
    };

    function Panel(props: Presentation) {
      const list = () => {
        void props.revision;
        return props.card && props.screenshots.list(props.card.id);
      };
      return (
        <div class="workboard-screens">
          <Show
            when={props.card}
            fallback={<p class="workboard-detail__empty">{t("workboard.screensNoCard")}</p>}
          >
            {(card) => (
              <Show
                when={list()}
                fallback={
                  <p class="workboard-detail__empty" role="status">
                    {t("workboard.screenshotLoading")}
                  </p>
                }
              >
                {(settled) => {
                  const loaded = () => {
                    const current = settled();
                    return current.status === "loaded" ? current : undefined;
                  };
                  return (
                    <Show
                      when={loaded()}
                      fallback={
                        <p class="workboard-detail__empty">
                          {t("workboard.screenshotsUnavailable", {
                            error: (() => {
                              const current = settled();
                              return current.status === "unavailable" ? current.error : "";
                            })(),
                          })}
                        </p>
                      }
                    >
                      {(listed) => (
                        <>
                          <Show when={listed().result.live}>
                            {(live) => (
                              <LiveScreenshots
                                screenshots={props.screenshots}
                                cardId={card().id}
                                revision={props.revision}
                                live={live()}
                                listedAt={listed().listedAt}
                                onRefresh={() => props.screenshots.refresh()}
                              />
                            )}
                          </Show>
                          <h3 class="workboard-screens__heading">
                            {t("workboard.screensCommitted")}
                          </h3>
                          {hasNoCommittedRounds(listed().result.committed) ? (
                            <p class="workboard-detail__empty">
                              {t("workboard.screensCommittedEmpty")}
                            </p>
                          ) : (
                            <ScreenshotRounds
                              screenshots={props.screenshots}
                              cardId={card().id}
                              revision={props.revision}
                              committed={listed().result.committed}
                            />
                          )}
                        </>
                      )}
                    </Show>
                  );
                }}
              </Show>
            )}
          </Show>
        </div>
      );
    }

    const stopHost = host.subscribe(draw);
    const stopState = workboard.subscribe(draw);
    const disposeRoot = render(
      () => <Show when={presentation()}>{(current) => <Panel {...current()} />}</Show>,
      container,
    );
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
        screenshots = undefined;
        disposeRoot();
      },
    };
  };
}
