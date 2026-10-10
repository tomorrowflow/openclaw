import type { WorkboardBoardSummary, WorkboardTrustResult } from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { workboardPopoverRef } from "./view-popover.ts";

/** Keyed by board revision so card changes reload the projection. */
export type BoardTrustState = { key: string } & (
  | { status: "loading" }
  | { status: "loaded"; result: WorkboardTrustResult }
  | { status: "unavailable"; error: string }
);

/** Trust KPIs only exist for project boards that send cards to a node (D53). */
export function boardTrustKey(board: WorkboardBoardSummary | null | undefined): string | undefined {
  return board?.orchestration?.defaultTarget || board?.orchestration?.targetRoutes?.length
    ? `${board.id}:${board.total}:${board.updatedAt ?? 0}`
    : undefined;
}

export async function loadBoardTrust(
  client: GatewayBrowserClient,
  boardId: string,
  key: string,
): Promise<BoardTrustState> {
  try {
    const result = await client.request<WorkboardTrustResult>("workboard.cards.trust", {
      boardId,
    });
    return { key, status: "loaded", result };
  } catch (error) {
    return { key, status: "unavailable", error: formatUiError(error) };
  }
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–";
}

function weekLabel(weekStart: number): string {
  return new Date(weekStart).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function renderTrustDetails(result: WorkboardTrustResult) {
  const peak = Math.max(1, ...result.weeks.map((week) => week.accepted));
  return html`
    <strong>${t("workboard.trustTitle")}</strong>
    <p>${t("workboard.trustExplain")}</p>
    <table class="workboard-trust-table">
      <caption>
        ${t("workboard.trustWeeks")}
      </caption>
      <thead>
        <tr>
          <th scope="col">${t("workboard.trustWeek")}</th>
          <th scope="col">${t("workboard.trustAutonomous")}</th>
          <th scope="col">${t("workboard.trustLeadTime")}</th>
        </tr>
      </thead>
      <tbody>
        ${result.weeks.map(
          (week) => html`
            <tr>
              <th scope="row">${weekLabel(week.weekStart)}</th>
              <td>
                <span class="workboard-trust-bar" aria-hidden="true">
                  <span
                    class="workboard-trust-bar__accepted"
                    style=${`inline-size: ${(week.accepted / peak) * 100}%`}
                  >
                    <span
                      class="workboard-trust-bar__autonomous"
                      style=${`inline-size: ${week.accepted ? (week.autonomous / week.accepted) * 100 : 0}%`}
                    ></span>
                  </span>
                </span>
                <span
                  >${t("workboard.trustOfAccepted", {
                    autonomous: String(week.autonomous),
                    accepted: String(week.accepted),
                  })}</span
                >
              </td>
              <td>${formatDurationCompact(week.medianLeadTimeMs) ?? "–"}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
    <table class="workboard-trust-table">
      <caption>
        ${t("workboard.trustClasses")}
      </caption>
      <thead>
        <tr>
          <th scope="col">${t("workboard.trustClass")}</th>
          <th scope="col">${t("workboard.trustTickets")}</th>
          <th scope="col">${t("workboard.trustCleanAccept")}</th>
          <th scope="col">${t("workboard.trustFirstPass")}</th>
          <th scope="col">${t("workboard.trustRework")}</th>
        </tr>
      </thead>
      <tbody>
        ${result.classes.map(
          (entry) => html`
            <tr>
              <th scope="row">${entry.taskClass}</th>
              <td>${entry.tickets}</td>
              <td>${percent(entry.cleanAccepted, entry.accepted)}</td>
              <td>${percent(entry.firstPass, entry.tickets)}</td>
              <td>${entry.reworkRounds}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;
}

export function renderBoardTrustHeading(trust: BoardTrustState | undefined) {
  if (!trust) {
    return nothing;
  }
  const result = trust.status === "loaded" ? trust.result : undefined;
  if (result && result.total.tickets === 0) {
    return nothing;
  }
  const week = result?.weeks.at(-1);
  const popoverId = "workboard-trust-popover";
  const label = !result
    ? t(trust.status === "loading" ? "workboard.trustLoading" : "workboard.trustUnavailable")
    : week?.accepted
      ? t("workboard.trustThisWeek", {
          autonomous: String(week.autonomous),
          accepted: String(week.accepted),
        })
      : t("workboard.trustNoneThisWeek");
  return html`
    <div class="workboard-heading__automation workboard-heading__trust">
      <button
        class="workboard-heading__automation-name workboard-heading__trust-trigger"
        type="button"
        popovertarget=${popoverId}
        aria-haspopup="dialog"
        aria-expanded="false"
        ?disabled=${!result}
        title=${trust.status === "unavailable" ? trust.error : nothing}
      >
        <span class="workboard-heading__automation-icon" aria-hidden="true">${icons.check}</span>
        <span class="workboard-heading__automation-label">${label}</span>
      </button>
      ${
        result
          ? html`<div
              id=${popoverId}
              class="workboard-automation-info workboard-trust-info"
              popover="auto"
              role="dialog"
              aria-label=${t("workboard.trustTitle")}
              ${ref(workboardPopoverRef("start"))}
            >
              ${renderTrustDetails(result)}
            </div>`
          : nothing
      }
    </div>
  `;
}
