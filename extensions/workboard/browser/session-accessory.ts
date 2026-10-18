import { html, nothing, render } from "lit";
import type { ControlUiAccessory } from "openclaw/plugin-sdk/control-ui";
import { icons } from "./components/icons.ts";
import { t } from "./i18n/index.ts";
import { workboardCardBoardId } from "./lib/workboard/board-filter.ts";
import type { WorkboardCapability } from "./lib/workboard/capability.ts";
import { isActiveWorkboardCard, workboardGrillSessionName } from "./lib/workboard/card-state.ts";
import { isWorkboardNodeTicket } from "./lib/workboard/execution.ts";
import { findWorkboardSessionCard } from "./lib/workboard/session-links.ts";
import { matchesAgentScope } from "./pages/workboard/agent-filter.ts";
import { workboardPageTarget } from "./pages/workboard/page-target.ts";

export function createWorkboardSessionAccessory(
  workboard: WorkboardCapability,
): ControlUiAccessory["mount"] {
  return (container, initialContext) => {
    let context = initialContext;
    let disposed = false;
    const host = context.host;
    const draw = () => {
      const card =
        context.presented && host.connection.connected
          ? findWorkboardSessionCard(workboard.state.cards, context.props.sessionKey)
          : null;
      const target = card ? workboardPageTarget(workboardCardBoardId(card)) : null;
      // While the card waits on its grilling, the chip leads to the grill session.
      const grillSessionKey = card?.stage?.kind === "grilling" ? card.grill?.sessionKey : undefined;
      const statusLabel = card
        ? grillSessionKey
          ? t("workboard.sessionChipGrilling", { name: workboardGrillSessionName(card) })
          : t(`workboard.status.${card.status}`)
        : "";
      render(
        card && isActiveWorkboardCard(card) && target
          ? html`<div class="workboard-session-chips">
              <a
                class="workboard-session-chip"
                href=${host.navigation.pageHref(target)}
                aria-label=${`${card.title} — ${statusLabel}`}
                @click=${(event: MouseEvent) => {
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
                  if (
                    !matchesAgentScope(
                      card,
                      host.agents.defaultId ?? host.connection.assistantAgentId,
                      host.agents.scopeId,
                    )
                  ) {
                    host.agents.setScope(null);
                  }
                  if (grillSessionKey) {
                    host.sessions.open({ sessionKey: grillSessionKey });
                    return;
                  }
                  host.navigation.openPage(target);
                }}
                >${icons.kanban}<span class="workboard-session-chip__title">${card.title}</span
                ><span class="workboard-session-chip__status">${statusLabel}</span></a
              >${
                isWorkboardNodeTicket(card)
                  ? html`<button
                      type="button"
                      class="workboard-session-screens"
                      title=${t("workboard.screensOpen")}
                      @click=${() => {
                        if (!disposed && context.presented && !context.signal.aborted) {
                          host.ui.openPanel("screens", context.props);
                        }
                      }}
                    >
                      ${icons.image}<span>${t("workboard.screens")}</span>
                    </button>`
                  : nothing
              }
            </div>`
          : nothing,
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
        disposed = true;
        stopHost();
        stopState();
        render(nothing, container);
      },
    };
  };
}
