/** @jsxImportSource @solidjs/web */
import type {
  WorkboardOverviewCard,
  WorkboardOverviewInFlight,
  WorkboardOverviewResult,
  WorkboardOverviewShipped,
  WorkboardOverviewWaiting,
} from "@openclaw/workboard-contract";
import { render, type JSX } from "@solidjs/web";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createSignal, For, Show } from "solid-js";
import { Markdown } from "../../components/host-components.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";
import { WORKBOARD_CHANGED_EVENT, WORKBOARD_STATUSES } from "../../lib/workboard/types.ts";
import { workboardPageTarget } from "../workboard/page-target.ts";
import { CardStage } from "../workboard/view-card-content.tsx";
import { cardRelativeTime } from "../workboard/view-card-time.tsx";

const compactTokens = new Intl.NumberFormat(undefined, { notation: "compact" });

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function MetaLine(props: { parts: ReadonlyArray<JSX.Element | undefined> }) {
  const visible = () => props.parts.filter((part) => part !== undefined);
  return (
    <Show when={visible().length}>
      <p class="workboard-overview__meta">
        <For each={visible()}>{(part) => <span>{part}</span>}</For>
      </p>
    </Show>
  );
}

// A running stage already names its node and round.
function inFlightMeta(row: WorkboardOverviewInFlight) {
  const running = row.stage?.kind === "running";
  return [
    row.nodeId && !running ? t("workboard.overviewNode", { node: row.nodeId }) : undefined,
    row.round && !running ? t("workboard.overviewRound", { round: String(row.round) }) : undefined,
    row.contextTokens === undefined
      ? undefined
      : t("workboard.overviewContext", { tokens: compactTokens.format(row.contextTokens) }),
  ];
}

function shippedMeta(row: WorkboardOverviewShipped) {
  return [
    row.pullRequestUrl ? (
      <a href={row.pullRequestUrl} target="_blank" rel="noreferrer">
        {t("workboard.overviewPullRequest")}
      </a>
    ) : undefined,
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
  ];
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

function Band<Row extends WorkboardOverviewCard>(props: {
  id: string;
  title: string;
  empty: string;
  rows: readonly Row[];
  children: (row: Row) => JSX.Element;
}) {
  return (
    <section
      class="workboard-overview__band"
      aria-labelledby={`workboard-overview-${props.id}`}
    >
      <h2 id={`workboard-overview-${props.id}`}>
        <span>{props.title}</span>
        <span class="workboard-overview__count">{props.rows.length}</span>
      </h2>
      <Show
        when={props.rows.length}
        fallback={<p class="workboard-overview__empty">{props.empty}</p>}
      >
        <ul class="workboard-overview__rows">
          <For each={props.rows}>{(row) => props.children(row)}</For>
        </ul>
      </Show>
    </section>
  );
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
    // Cards with a sample read in flight; the change event that follows reloads the overview.
    const marking = new Set<string>();
    // A failed read stays on screen while its card still waits in Needs you.
    let markError: { cardId: string; message: string } | undefined;
    // The plain state above owns the page; this revision tells the rendering to reread it.
    const [revision, setRevision] = createSignal(0);
    const draw = () => {
      if (!disposed) {
        setRevision((value) => value + 1);
      }
    };
    const read = <T,>(value: () => T) => {
      void revision();
      return value();
    };

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
            if (!loaded.needsYou.some((row) => row.cardId === markError?.cardId)) {
              markError = undefined;
            }
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

    const markRead = (row: WorkboardOverviewWaiting) => {
      marking.add(row.cardId);
      markError = undefined;
      draw();
      void host
        .request("workboard.cards.sampleRead", { id: row.cardId })
        .then(
          () => {
            // The change event usually reloads already; this read covers a missed one.
            stale = true;
            load();
          },
          (failure: unknown) => {
            markError = {
              cardId: row.cardId,
              message: t("workboard.overviewMarkReadFailed", { error: formatUiError(failure) }),
            };
          },
        )
        .finally(() => {
          marking.delete(row.cardId);
          draw();
        });
    };

    function WaitingMeta(props: { row: WorkboardOverviewWaiting }) {
      return (
        <Show
          when={read(
            () =>
              props.row.reason === "sampled" &&
              host.connection.connected &&
              host.connection.canWrite,
          )}
        >
          <p class="workboard-overview__actions">
            <button
              class="btn btn--sm"
              type="button"
              disabled={read(() => marking.has(props.row.cardId))}
              onClick={() => markRead(props.row)}
            >
              {t("workboard.overviewMarkRead")}
            </button>
          </p>
        </Show>
      );
    }

    function Row(props: {
      row: WorkboardOverviewCard;
      now: number;
      tag?: string;
      children?: JSX.Element;
    }) {
      const boards = () => read(() => workboard.state.boards);
      const board = () => boards().find((entry) => entry.id === props.row.boardId);
      return (
        <li class="workboard-overview__row">
          <div class="workboard-overview__row-head">
            <a
              class="workboard-overview__title"
              href={host.navigation.pageHref(workboardPageTarget(props.row.boardId))}
              onClick={(event) => openCard(event, props.row)}
            >
              {props.row.title}
            </a>
            <Show when={props.tag}>
              <span class="workboard-overview__tag">{props.tag}</span>
            </Show>
          </div>
          <Show when={props.row.summary}>
            {(summary) => (
              <div class="workboard-card__notes">
                <Markdown markdown={summary()} />
              </div>
            )}
          </Show>
          <CardStage stage={props.row.stage} now={props.now} />
          <Show when={boards().length > 1}>
            <p class="workboard-overview__board">
              {workboardBoardName(board() ?? { id: props.row.boardId })}
            </p>
          </Show>
          {props.children}
        </li>
      );
    }

    function Result(props: { loaded: WorkboardOverviewResult }) {
      const now = () => read(() => Date.now());
      const week = () => props.loaded.week;
      return (
        <>
          <p class="workboard-overview__counters">
            <For each={openCounts(props.loaded)}>{(entry) => <span>{entry}</span>}</For>
            <span>
              {week().accepted
                ? t("workboard.trustThisWeek", {
                    autonomous: String(week().autonomous),
                    accepted: String(week().accepted),
                  })
                : t("workboard.trustNoneThisWeek")}
            </span>
          </p>
          <div class="workboard-overview__bands">
            <Band
              id="needs-you"
              title={t("workboard.overviewNeedsYou")}
              empty={t("workboard.overviewNeedsYouEmpty")}
              rows={props.loaded.needsYou}
            >
              {(row) => (
                <Row row={row} now={now()} tag={t(`workboard.overviewReasons.${row.reason}`)}>
                  <WaitingMeta row={row} />
                </Row>
              )}
            </Band>
            <Band
              id="in-flight"
              title={t("workboard.overviewInFlight")}
              empty={t("workboard.overviewInFlightEmpty")}
              rows={props.loaded.inFlight}
            >
              {(row) => (
                <Row row={row} now={now()}>
                  <MetaLine parts={inFlightMeta(row)} />
                </Row>
              )}
            </Band>
            <Band
              id="shipped"
              title={t("workboard.overviewShipped")}
              empty={t("workboard.overviewShippedEmpty")}
              rows={props.loaded.shipped}
            >
              {(row) => (
                <Row row={row} now={now()}>
                  <MetaLine parts={shippedMeta(row)} />
                </Row>
              )}
            </Band>
            <Band
              id="insights"
              title={t("workboard.overviewInsights")}
              empty={t("workboard.overviewInsightsEmpty")}
              rows={props.loaded.insights}
            >
              {(row) => (
                <Row row={row} now={now()} tag={t(`workboard.overviewLabels.${row.label}`)}>
                  <MetaLine
                    parts={[
                      <>
                        {t("workboard.overviewFiled")} {cardRelativeTime(row.createdAt, now())}
                      </>,
                    ]}
                  />
                </Row>
              )}
            </Band>
          </div>
        </>
      );
    }

    function Page() {
      return (
        <section class="workboard-overview">
          <header class="workboard-overview__heading">
            <h1>{t("workboard.overviewTitle")}</h1>
          </header>
          <Show when={read(() => error)}>
            {(message) => (
              <p class="workboard-overview__empty" role="status">
                {t("workboard.overviewUnavailable", { error: message() })}
              </p>
            )}
          </Show>
          <Show when={read(() => markError)}>
            {(failure) => (
              <p class="workboard-overview__empty" role="status">
                {failure().message}
              </p>
            )}
          </Show>
          <Show
            when={read(() => result)}
            fallback={
              <Show when={!read(() => error)}>
                <p class="workboard-overview__empty" role="status">
                  {t("workboard.overviewLoading")}
                </p>
              </Show>
            }
          >
            {(loaded) => <Result loaded={loaded()} />}
          </Show>
        </section>
      );
    }

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
    const disposeRoot = render(() => <Page />, container);
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
        disposeRoot();
      },
    };
  };
}
