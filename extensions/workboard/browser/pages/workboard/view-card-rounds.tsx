/** @jsxImportSource @solidjs/web */
import { For, Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import type {
  WorkboardNodeDecision,
  WorkboardNodeRound,
  WorkboardRoundReviewTimes,
} from "../../lib/workboard/types.ts";

function Decisions(props: { decisions: readonly WorkboardNodeDecision[] }) {
  return (
    <>
      <h4>{t("workboard.roundDecisions")}</h4>
      <ol class="workboard-round__decisions">
        <For each={props.decisions}>
          {(entry) => (
            <li>
              <span class="workboard-round__phase">{entry.phase}</span>{" "}
              <div class="workboard-round__decision">
                <strong>{entry.decision}</strong>{" "}
                <Show when={entry.why}>
                  <p>{entry.why}</p>{" "}
                </Show>
                <Show when={entry.evidence || entry.result || entry.ts}>
                  <p class="workboard-round__meta">
                    <Show when={entry.evidence}>
                      <code>{entry.evidence}</code>{" "}
                    </Show>
                    <Show when={entry.result}>
                      <span>{entry.result}</span>{" "}
                    </Show>
                    <Show when={entry.ts}>
                      <time>{entry.ts}</time>
                    </Show>
                  </p>
                </Show>
              </div>
            </li>
          )}
        </For>
      </ol>
    </>
  );
}

/**
 * What each node ticket round decided, newest round first; its changes have
 * their own tab, its review times sit with its sessions in Details.
 */
export function NodeRounds(props: { rounds: readonly WorkboardNodeRound[] | undefined }) {
  const decided = () =>
    (props.rounds?.filter((entry) => entry.decisions?.length) ?? []).toReversed();
  return (
    <For each={decided()} keyed={(entry) => entry.round}>
      {(entry) => (
        <section class="workboard-detail__section workboard-round">
          <h3>{roundName(entry().round)}</h3>
          <Decisions decisions={entry().decisions ?? []} />
        </section>
      )}
    </For>
  );
}

export function roundName(round: number): string {
  return round === 0
    ? t("workboard.roundFirst")
    : t("workboard.roundRework", { number: String(round) });
}

/** How long a round's verification ran and when the agent's verdict followed it. */
export function roundReviewLines(entry: WorkboardRoundReviewTimes, now: number): string[] {
  const verification = entry.verification;
  return [
    ...(verification
      ? [
          verification.endedAt === undefined
            ? t("workboard.reviewTimesVerifying", {
                duration: duration(now - verification.startedAt),
              })
            : t("workboard.reviewTimesVerification", {
                duration: duration(verification.endedAt - verification.startedAt),
              }),
        ]
      : []),
    ...(entry.verdictAt === undefined ? [] : [verdictLine(entry.verdictAt, entry)]),
  ];
}

/** The verdict's wait from the verification's end, or from the import when it came first. */
function verdictLine(verdictAt: number, entry: WorkboardRoundReviewTimes): string {
  const verifiedAt = entry.verification?.endedAt;
  return verifiedAt !== undefined && verdictAt >= verifiedAt
    ? t("workboard.reviewTimesVerdictAfterVerification", {
        duration: duration(verdictAt - verifiedAt),
      })
    : t("workboard.reviewTimesVerdictAfterImport", {
        duration: duration(verdictAt - entry.importedAt),
      });
}

function duration(ms: number): string {
  return formatDurationCompact(ms) ?? t("workboard.reviewTimesInstant");
}
