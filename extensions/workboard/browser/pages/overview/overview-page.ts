import type {
  WorkboardOverviewCard,
  WorkboardOverviewInFlight,
  WorkboardOverviewResult,
  WorkboardOverviewShipped,
  WorkboardOverviewWaiting,
  WorkboardOverviewInsight,
} from "@openclaw/workboard-contract";
import { html, nothing, render, type TemplateResult } from "lit";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { renderMarkdown } from "../../components/host-components.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";
import { WORKBOARD_CHANGED_EVENT, WORKBOARD_STATUSES } from "../../lib/workboard/types.ts";
import { workboardPageTarget } from "../workboard/page-target.ts";
import { renderCardStage } from "../workboard/view-card-content.ts";
import { cardRelativeTime } from "../workboard/view-card-time.ts";

const compactTokens = new Intl.NumberFormat(undefined, { notation: "compact" });

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function metaLine(parts: Array<string | TemplateResult | undefined>) {
  const visible = parts.filter((part) => part !== undefined);
  return visible.length
    ? html`<p class="workboard-overview__meta">
        ${visible.map((part) => html`<span>${part}</span>`)}
      </p>`
    : nothing;
}

// A running stage already names its node and round.
function inFlightMeta(row: WorkboardOverviewInFlight) {
  const running = row.stage?.kind === "running";
  return metaLine([
    row.nodeId && !running ? t("workboard.overviewNode", { node: row.nodeId }) : undefined,
    row.round && !running ? t("workboard.overviewRound", { round: String(row.round) }) : undefined,
    row.contextTokens === undefined
      ? undefined
      : t("workboard.overviewContext", { tokens: compactTokens.format(row.contextTokens) }),
  ]);
}

function shippedMeta(row: WorkboardOverviewShipped) {
  return metaLine([
    row.pullRequestUrl
      ? html`<a href=${row.pullRequestUrl} target="_blank" rel="noreferrer"
          >${t("workboard.overviewPullRequest")}</a
        >`
      : undefined,
    row.rounds === undefined
      ? undefined
      : row.rounds === 1
        ? t("workboard.overviewOneRound")
        : t("workboard.overviewRounds", { rounds: String(row.rounds) }),
    row.decidedBy === undefined
      ? undefined
      : t(
          row.decidedBy === "agent"
            ? "workboard.overviewDecidedAgent"
            : "workboard.overviewDecidedOperator",
        ),
    row.sampled === undefined
      ? undefined
      : t(row.sampled ? "workboard.overviewSampled" : "workboard.overviewNotSampled"),
    row.shadowVerdict
      ? t("workboard.overviewShadowVerdict", { verdict: row.shadowVerdict })
      : undefined,
  ]);
}

function openCounts(result: WorkboardOverviewResult) {
  const counts = WORKBOARD_STATUSES.flatMap((status) => {
    const count = result.open[status];
    return count
      ? [
          t("workboard.overviewOpenCount", {
            count: String(count),
            status: t(`workboard.status.${status}`),
          }),
        ]
      : [];
  });
  return counts.length ? counts : [t("workboard.overviewNoOpen")];
}

export function createOverviewPage(workboard: WorkboardCapability): ControlUiView {
  return (container, initialContext) => {
    const host = initialContext.host;
    let context = initialContext;
    // A failed reload keeps the last result on screen beside its error.
    let result: WorkboardOverviewResult | undefined;
    let error: string | undefined;
    let disposed = false;
    let inFlight = false;
    let stale = true;

    const live = () => !disposed && context.presented && host.connection.connected;
    // One read at a time; changes during a read queue one more, so bursts cost two reads.
    const load = () => {
      if (!live() || !stale || inFlight) {
        return;
      }
      inFlight = true;
      stale = false;
      void host
        .request<WorkboardOverviewResult>("workboard.overview", {})
        .then(
          (loaded) => {
            result = loaded;
            error = undefined;
          },
          (failure: unknown) => {
            error = formatUiError(failure);
          },
        )
        .then(() => {
          inFlight = false;
          if (!disposed) {
            draw();
            load();
          }
        });
    };

    const openCard = (event: MouseEvent, row: WorkboardOverviewCard) => {
      if (!isPlainClick(event)) {
        return;
      }
      event.preventDefault();
      workboard.state.revealCardId = row.cardId;
      host.navigation.openPage(workboardPageTarget(row.boardId));
    };

    const renderRow = (
      row: WorkboardOverviewCard,
      now: number,
      tag: string | undefined,
      meta: unknown,
    ) => {
      const board = workboard.state.boards.find((entry) => entry.id === row.boardId);
      const showBoard = workboard.state.boards.length > 1;
      return html`<li class="workboard-overview__row">
        <div class="workboard-overview__row-head">
          <a
            class="workboard-overview__title"
            href=${host.navigation.pageHref(workboardPageTarget(row.boardId))}
            @click=${(event: MouseEvent) => openCard(event, row)}
            >${row.title}</a
          >
          ${tag ? html`<span class="workboard-overview__tag">${tag}</span>` : nothing}
        </div>
        ${
          row.summary
            ? html`<div class="workboard-card__notes">${renderMarkdown(row.summary)}</div>`
            : nothing
        }
        ${renderCardStage(row.stage, now)}
        ${
          showBoard
            ? html`<p class="workboard-overview__board">
                ${workboardBoardName(board ?? { id: row.boardId })}
              </p>`
            : nothing
        }
        ${meta}
      </li>`;
    };

    const renderBand = <Row extends WorkboardOverviewCard>(
      id: string,
      title: string,
      empty: string,
      rows: readonly Row[],
      renderEntry: (row: Row) => TemplateResult,
    ) => html`<section
      class="workboard-overview__band"
      aria-labelledby=${`workboard-overview-${id}`}
    >
      <h2 id=${`workboard-overview-${id}`}>
        <span>${title}</span><span class="workboard-overview__count">${rows.length}</span>
      </h2>
      ${
        rows.length
          ? html`<ul class="workboard-overview__rows">
              ${rows.map(renderEntry)}
            </ul>`
          : html`<p class="workboard-overview__empty">${empty}</p>`
      }
    </section>`;

    const renderResult = (loaded: WorkboardOverviewResult) => {
      const now = Date.now();
      const week = loaded.week;
      return html`
        <p class="workboard-overview__counters">
          ${openCounts(loaded).map((entry) => html`<span>${entry}</span>`)}
          <span
            >${
              week.accepted
                ? t("workboard.trustThisWeek", {
                    autonomous: String(week.autonomous),
                    accepted: String(week.accepted),
                  })
                : t("workboard.trustNoneThisWeek")
            }</span
          >
        </p>
        <div class="workboard-overview__bands">
          ${renderBand(
            "needs-you",
            t("workboard.overviewNeedsYou"),
            t("workboard.overviewNeedsYouEmpty"),
            loaded.needsYou,
            (row: WorkboardOverviewWaiting) =>
              renderRow(row, now, t(`workboard.overviewReasons.${row.reason}`), nothing),
          )}
          ${renderBand(
            "in-flight",
            t("workboard.overviewInFlight"),
            t("workboard.overviewInFlightEmpty"),
            loaded.inFlight,
            (row: WorkboardOverviewInFlight) => renderRow(row, now, undefined, inFlightMeta(row)),
          )}
          ${renderBand(
            "shipped",
            t("workboard.overviewShipped"),
            t("workboard.overviewShippedEmpty"),
            loaded.shipped,
            (row: WorkboardOverviewShipped) => renderRow(row, now, undefined, shippedMeta(row)),
          )}
          ${renderBand(
            "insights",
            t("workboard.overviewInsights"),
            t("workboard.overviewInsightsEmpty"),
            loaded.insights,
            (row: WorkboardOverviewInsight) =>
              renderRow(
                row,
                now,
                t(`workboard.overviewLabels.${row.label}`),
                metaLine([
                  html`${t("workboard.overviewFiled")} ${cardRelativeTime(row.createdAt, now)}`,
                ]),
              ),
          )}
        </div>
      `;
    };

    const draw = () => {
      if (disposed) {
        return;
      }
      render(
        html`<section class="workboard-overview">
          <header class="workboard-overview__heading">
            <h1>${t("workboard.overviewTitle")}</h1>
          </header>
          ${
            error
              ? html`<p class="workboard-overview__empty" role="status">
                  ${t("workboard.overviewUnavailable", { error })}
                </p>`
              : nothing
          }
          ${
            result
              ? renderResult(result)
              : error
                ? nothing
                : html`<p class="workboard-overview__empty" role="status">
                    ${t("workboard.overviewLoading")}
                  </p>`
          }
        </section>`,
        container,
      );
    };

    const update = () => {
      draw();
      load();
    };
    const stopEvents = host.onEvent(WORKBOARD_CHANGED_EVENT, () => {
      stale = true;
      load();
    });
    let connected = host.connection.connected;
    const stopHost = host.subscribe(() => {
      // A reconnect may have missed change events.
      if (host.connection.connected !== connected) {
        connected = host.connection.connected;
        stale = true;
      }
      update();
    });
    const stopCards = workboard.subscribe(draw);
    update();
    return {
      update(next) {
        context = next;
        update();
      },
      dispose() {
        disposed = true;
        stopEvents();
        stopHost();
        stopCards();
        render(nothing, container);
      },
    };
  };
}
