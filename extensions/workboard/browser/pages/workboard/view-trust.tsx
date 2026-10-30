/** @jsxImportSource @solidjs/web */
import type { WorkboardBoardSummary, WorkboardTrustResult } from "@openclaw/workboard-contract";
import { For, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.tsx";
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

const compactTokens = new Intl.NumberFormat(undefined, { notation: "compact" });

function tokens(count: number | undefined): string {
  return count === undefined ? "–" : compactTokens.format(count);
}

function weekLabel(weekStart: number): string {
  return new Date(weekStart).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function TrustDetails(props: { result: WorkboardTrustResult }) {
  const peak = () => Math.max(1, ...props.result.weeks.map((week) => week.accepted));
  return (
    <>
      <strong>{t("workboard.trustTitle")}</strong>
      <p>{t("workboard.trustExplain")}</p>
      <table class="workboard-trust-table">
        <caption>{t("workboard.trustWeeks")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("workboard.trustWeek")}</th>
            <th scope="col">{t("workboard.trustAutonomous")}</th>
            <th scope="col">{t("workboard.trustLeadTime")}</th>
            <th scope="col">{t("workboard.trustReviewWait")}</th>
            <th scope="col">{t("workboard.trustRunContext")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.result.weeks}>
            {(week) => (
              <tr>
                <th scope="row">{weekLabel(week.weekStart)}</th>
                <td>
                  <span class="workboard-trust-bar" aria-hidden="true">
                    <span
                      class="workboard-trust-bar__accepted"
                      style={{ "inline-size": `${(week.accepted / peak()) * 100}%` }}
                    >
                      <span
                        class="workboard-trust-bar__autonomous"
                        style={{
                          "inline-size": `${week.accepted ? (week.autonomous / week.accepted) * 100 : 0}%`,
                        }}
                      />
                    </span>
                  </span>
                  <span>
                    {t("workboard.trustOfAccepted", {
                      autonomous: String(week.autonomous),
                      accepted: String(week.accepted),
                    })}
                  </span>
                </td>
                <td>{formatDurationCompact(week.medianLeadTimeMs) ?? "–"}</td>
                <td>{formatDurationCompact(week.medianReviewWaitMs) ?? "–"}</td>
                <td>{tokens(week.medianContextTokens)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <table class="workboard-trust-table">
        <caption>{t("workboard.trustClasses")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("workboard.trustClass")}</th>
            <th scope="col">{t("workboard.trustTickets")}</th>
            <th scope="col">{t("workboard.trustCleanAccept")}</th>
            <th scope="col">{t("workboard.trustFirstPass")}</th>
            <th scope="col">{t("workboard.trustRework")}</th>
            <th scope="col">
              {t("workboard.trustOverZone", { tokens: tokens(props.result.smartZoneTokens) })}
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.result.classes}>
            {(entry) => (
              <tr>
                <th scope="row">{entry.taskClass}</th>
                <td>{entry.tickets}</td>
                <td>{percent(entry.cleanAccepted, entry.accepted)}</td>
                <td>{percent(entry.firstPass, entry.tickets)}</td>
                <td>{entry.reworkRounds}</td>
                <td>
                  {entry.contextMeasured > 0
                    ? t("workboard.trustOfRuns", {
                        breaches: String(entry.smartZoneBreaches),
                        runs: String(entry.contextMeasured),
                      })
                    : "–"}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <table class="workboard-trust-table">
        <caption>{t("workboard.trustVisual")}</caption>
        <tbody>
          <For each={[...props.result.classes, undefined]}>
            {(entry) => {
              const counts = () => entry ?? props.result.total;
              return (
                <tr>
                  <th scope="row">{entry?.taskClass ?? t("workboard.trustVisualTotal")}</th>
                  <td>
                    {counts().visualRounds > 0
                      ? t("workboard.trustVisualAgreed", {
                          agreed: String(counts().visualAgreedRounds),
                          rounds: String(counts().visualRounds),
                          rate: percent(counts().visualAgreedRounds, counts().visualRounds),
                        })
                      : "–"}
                  </td>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
      <Show when={props.result.classes.some((entry) => entry.rung)}>
        <RungWindows classes={props.result.classes} />
      </Show>
    </>
  );
}

// The voice-diary a-to-b rule counts blind rounds: at least 15 accepted, at least 80% clean.
const PROMOTION_ACCEPTED = 15;
const PROMOTION_CLEAN_SHARE = 0.8;

type TrustClass = WorkboardTrustResult["classes"][number];
type TrustCounts = WorkboardTrustResult["total"];

/**
 * Clean accepts a class at rung a still needs, assuming every next accept is
 * clean: enough to reach the count, and enough for the share
 * (clean + n >= 0.8 * (accepted + n), so n >= 4 * accepted - 5 * clean).
 */
export function promotionGap(blind: TrustCounts | undefined): number {
  const accepted = blind?.accepted ?? 0;
  const clean = blind?.cleanAccepted ?? 0;
  const forShare = Math.ceil(
    (PROMOTION_CLEAN_SHARE * accepted - clean) / (1 - PROMOTION_CLEAN_SHARE) - 1e-9,
  );
  return Math.max(0, PROMOTION_ACCEPTED - accepted, forShare);
}

function acceptedClean(counts: TrustCounts | undefined): string {
  return counts && counts.accepted > 0
    ? t("workboard.trustAcceptedClean", {
        accepted: String(counts.accepted),
        clean: String(counts.cleanAccepted),
      })
    : "–";
}

function dateLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function RungWindows(props: { classes: readonly TrustClass[] }) {
  return (
    <table class="workboard-trust-table">
      <caption>{t("workboard.trustRungs")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("workboard.trustClass")}</th>
          <th scope="col">{t("workboard.trustRung")}</th>
          <th scope="col">{t("workboard.trustBlindAt", { rung: "a" })}</th>
          <th scope="col">{t("workboard.trustBlindAt", { rung: "b" })}</th>
          <th scope="col">{t("workboard.trustBlindAt", { rung: "c" })}</th>
          <th scope="col">{t("workboard.trustSinceRung")}</th>
          <th scope="col">
            {t("workboard.trustToPromotion", {
              accepted: String(PROMOTION_ACCEPTED),
              percent: `${PROMOTION_CLEAN_SHARE * 100}%`,
            })}
          </th>
        </tr>
      </thead>
      <tbody>
        <For each={props.classes}>
          {(entry) => (
            <tr>
              <th scope="row">{entry.taskClass}</th>
              <td>
                {entry.rung
                  ? entry.rungSince === undefined
                    ? entry.rung
                    : t("workboard.trustRungSince", {
                        rung: entry.rung,
                        date: dateLabel(entry.rungSince),
                      })
                  : "–"}
              </td>
              <td>{acceptedClean(entry.blind.a)}</td>
              <td>{acceptedClean(entry.blind.b)}</td>
              <td>{acceptedClean(entry.blind.c)}</td>
              <td>
                {acceptedClean(entry.sinceRung)}
                <Show when={entry.sinceRung?.reworkedAccepts}>
                  {(count) => (
                    <span class="workboard-trust-table__note">
                      {t("workboard.trustReopened", { count: String(count()) })}
                    </span>
                  )}
                </Show>
                <Show when={entry.sinceRung?.regressions}>
                  {(count) => (
                    <span class="workboard-trust-table__note">
                      {t("workboard.trustRegressions", { count: String(count()) })}
                    </span>
                  )}
                </Show>
              </td>
              <td>
                {entry.rung !== "a"
                  ? "–"
                  : promotionGap(entry.blind.a) === 0
                    ? t("workboard.trustPromotionMet")
                    : t("workboard.trustPromotionGap", {
                        count: String(promotionGap(entry.blind.a)),
                      })}
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

const trustPopoverId = "workboard-trust-popover";

export function BoardTrustHeading(props: { trust: BoardTrustState | undefined }) {
  const result = () => (props.trust?.status === "loaded" ? props.trust.result : undefined);
  const label = () => {
    const loaded = result();
    const week = loaded?.weeks.at(-1);
    return !loaded
      ? t(
          props.trust?.status === "loading"
            ? "workboard.trustLoading"
            : "workboard.trustUnavailable",
        )
      : week?.accepted
        ? t("workboard.trustThisWeek", {
            autonomous: String(week.autonomous),
            accepted: String(week.accepted),
          })
        : t("workboard.trustNoneThisWeek");
  };
  return (
    <Show when={props.trust && result()?.total.tickets !== 0}>
      <div class="workboard-heading__automation workboard-heading__trust">
        <button
          class="workboard-heading__automation-name workboard-heading__trust-trigger"
          type="button"
          popovertarget={trustPopoverId}
          aria-haspopup="dialog"
          aria-expanded="false"
          disabled={!result()}
          title={props.trust?.status === "unavailable" ? props.trust.error : undefined}
        >
          <span class="workboard-heading__automation-icon" aria-hidden="true">
            {icons.check}
          </span>
          <span class="workboard-heading__automation-label">{label()}</span>
        </button>
        <Show when={result()}>
          {(loaded) => (
            <div
              id={trustPopoverId}
              class="workboard-automation-info workboard-trust-info"
              popover="auto"
              role="dialog"
              aria-label={t("workboard.trustTitle")}
              ref={workboardPopoverRef("start")}
            >
              <TrustDetails result={loaded()} />
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}
