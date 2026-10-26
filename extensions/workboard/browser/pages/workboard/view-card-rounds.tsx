/** @jsxImportSource @solidjs/web */
import { For, Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import type {
  WorkboardNodeDecision,
  WorkboardNodeRound,
  WorkboardRoundReviewTimes,
} from "../../lib/workboard/index.ts";

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
 * Each node ticket round's review times, then what each round decided, newest
 * round first; its changes have their own tab.
 */
export function NodeRounds(props: {
  rounds: readonly WorkboardNodeRound[] | undefined;
  times: readonly WorkboardRoundReviewTimes[] | undefined;
}) {
  const decided = () =>
    (props.rounds?.filter((entry) => entry.decisions?.length) ?? []).toReversed();
  return (
    <>
      <NodeReviewTimes times={props.times} now={Date.now()} />
      <For each={decided()} keyed={(entry) => entry.round}>
        {(entry) => (
          <section class="workboard-detail__section workboard-round">
            <h3>{roundName(entry().round)}</h3>
            <Decisions decisions={entry().decisions ?? []} />
          </section>
        )}
      </For>
    </>
  );
}

function roundName(round: number): string {
  return round === 0
    ? t("workboard.roundFirst")
    : t("workboard.roundRework", { number: String(round) });
}

/** How long each round's verification ran and when the agent's verdict followed, newest first. */
function NodeReviewTimes(props: {
  times: readonly WorkboardRoundReviewTimes[] | undefined;
  now: number;
}) {
  const rows = () =>
    (props.times ?? []).toReversed().flatMap((entry) => {
      const verification = entry.verification;
      const lines = [
        ...(verification
          ? [
              verification.endedAt === undefined
                ? t("workboard.reviewTimesVerifying", {
                    duration: duration(props.now - verification.startedAt),
                  })
                : t("workboard.reviewTimesVerification", {
                    duration: duration(verification.endedAt - verification.startedAt),
                  }),
            ]
          : []),
        ...(entry.verdictAt === undefined ? [] : [verdictLine(entry.verdictAt, entry)]),
      ];
      return lines.map((line, index) => ({
        key: `${entry.round}:${index}`,
        round: entry.round,
        line,
      }));
    });
  return (
    <Show when={rows().length}>
      <section class="workboard-detail__section workboard-review-times">
        <h3>{t("workboard.reviewTimesLabel")}</h3>
        <ol class="workboard-detail__list workboard-detail__events">
          <For each={rows()} keyed={(row) => row.key}>
            {(row) => (
              <li>
                <span>{row().line}</span>
                <span>{roundName(row().round)}</span>
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  );
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
