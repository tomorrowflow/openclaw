/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiAccessory } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createMemo, createSignal, Show } from "solid-js";
import { icons } from "./components/icons.tsx";
import { t } from "./i18n/index.ts";
import { workboardCardBoardId } from "./lib/workboard/board-filter.ts";
import { isActiveWorkboardCard, workboardGrillSessionName } from "./lib/workboard/card-state.ts";
import { normalizeWorkboardChange } from "./lib/workboard/change-payload.ts";
import { isWorkboardNodeTicket } from "./lib/workboard/execution.ts";
import { normalizeCardsPayload } from "./lib/workboard/normalization.ts";
import { findWorkboardSessionCard } from "./lib/workboard/session-links.ts";
import { WORKBOARD_CHANGED_EVENT, type WorkboardCard } from "./lib/workboard/types.ts";
import { matchesAgentScope } from "./pages/workboard/agent-filter.ts";
import { workboardPageTarget } from "./pages/workboard/page-target.ts";

export function createWorkboardSessionAccessory(): ControlUiAccessory["mount"] {
  return (container, initialContext) => {
    let context = initialContext;
    let disposed = false;
    const host = context.host;
    const [revision, setRevision] = createSignal(0);
    const publish = () => setRevision((value) => value + 1);
    let sessionKey: string | null = null;
    let cards: WorkboardCard[] = [];
    let cardsRevision: ReturnType<typeof normalizeWorkboardChange> = null;
    let load: object | null = null;
    let pending = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    function clearRetry() {
      clearTimeout(retry);
      retry = undefined;
    }
    async function refresh() {
      if (!sessionKey) {
        return;
      }
      if (load) {
        pending = true;
        return;
      }
      const token = {};
      load = token;
      const key = sessionKey;
      try {
        do {
          pending = false;
          const payload = await host.request("workboard.cards.list", {
            sessionKey: key,
            ...(cardsRevision ? { sinceRevision: { ...cardsRevision, sessionKey: key } } : {}),
          });
          if (load !== token) {
            return;
          }
          if (!isRecord(payload) || (payload.unchanged !== true && !Array.isArray(payload.cards))) {
            throw new Error("Invalid Workboard session response");
          }
          if (payload.unchanged !== true) {
            cards = normalizeCardsPayload(payload).cards;
          }
          const receipt = isRecord(payload.revision) ? payload.revision : {};
          cardsRevision = normalizeWorkboardChange({
            epoch: receipt.epoch,
            revision: receipt.revision,
          });
          clearRetry();
          publish();
        } while (pending);
      } catch {
        if (load === token && retry === undefined) {
          retry = setTimeout(() => {
            retry = undefined;
            void refresh();
          }, 2_000);
        }
      } finally {
        if (load === token) {
          load = null;
        }
      }
    }
    function sync() {
      const key =
        context.presented && !context.signal.aborted && host.connection.connected
          ? host.sessions.normalizeKey(context.props.sessionKey)
          : "";
      const next = key && key !== "global" && key !== "unknown" ? key : null;
      if (next !== sessionKey) {
        sessionKey = next;
        cards = [];
        cardsRevision = null;
        load = null;
        pending = false;
        clearRetry();
        void refresh();
      }
      publish();
    }
    function SessionAccessory() {
      const card = createMemo(() => {
        revision();
        const current =
          context.presented && host.connection.connected
            ? findWorkboardSessionCard(cards, context.props.sessionKey)
            : null;
        return current && isActiveWorkboardCard(current) ? current : null;
      });
      // While the card waits on its grilling, the chip leads to the grill session.
      const grillSessionKey = (current: WorkboardCard) =>
        current.stage?.kind === "grilling" ? current.grill?.sessionKey : undefined;
      const statusLabel = (current: WorkboardCard) =>
        grillSessionKey(current)
          ? t("workboard.sessionChipGrilling", { name: workboardGrillSessionName(current) })
          : t(`workboard.status.${current.status}`);
      return (
        <Show when={card()}>
          {(current) => (
            <div class="workboard-session-chips">
              <a
                class="workboard-session-chip"
                href={host.navigation.pageHref(
                  workboardPageTarget(workboardCardBoardId(current())),
                )}
                aria-label={`${current().title} — ${statusLabel(current())}`}
                onClick={(event: MouseEvent) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  if (
                    disposed ||
                    !context.presented ||
                    context.signal.aborted ||
                    !host.connection.connected
                  ) {
                    return;
                  }
                  const activeCard = findWorkboardSessionCard(cards, context.props.sessionKey);
                  if (!activeCard || !isActiveWorkboardCard(activeCard)) {
                    return;
                  }
                  if (
                    !matchesAgentScope(
                      activeCard,
                      host.agents.defaultId ?? host.connection.assistantAgentId,
                      host.agents.scopeId,
                    )
                  ) {
                    host.agents.setScope(null);
                  }
                  const grillKey = grillSessionKey(activeCard);
                  if (grillKey) {
                    host.sessions.open({ sessionKey: grillKey });
                    return;
                  }
                  host.navigation.openPage(workboardPageTarget(workboardCardBoardId(activeCard)));
                }}
              >
                {icons.kanban}
                <span class="workboard-session-chip__title">{current().title}</span>
                <span class="workboard-session-chip__status">{statusLabel(current())}</span>
              </a>
              <Show when={isWorkboardNodeTicket(current())}>
                <button
                  type="button"
                  class="workboard-session-screens"
                  title={t("workboard.screensOpen")}
                  onClick={() => {
                    if (!disposed && context.presented && !context.signal.aborted) {
                      host.ui.openPanel("screens", context.props);
                    }
                  }}
                >
                  {icons.image}
                  <span>{t("workboard.screens")}</span>
                </button>
              </Show>
            </div>
          )}
        </Show>
      );
    }
    const disposeRoot = render(() => <SessionAccessory />, container);
    const stopHost = host.subscribe(sync);
    const stopEvents = host.onEvent(WORKBOARD_CHANGED_EVENT, (payload) => {
      const change = normalizeWorkboardChange(payload);
      if (
        change &&
        cardsRevision?.epoch === change.epoch &&
        cardsRevision.revision === change.cardsRevision
      ) {
        return;
      }
      void refresh();
    });
    sync();
    return {
      update(next) {
        context = next;
        sync();
      },
      dispose() {
        disposed = true;
        stopHost();
        load = null;
        sessionKey = null;
        clearRetry();
        stopEvents();
        disposeRoot();
      },
    };
  };
}
