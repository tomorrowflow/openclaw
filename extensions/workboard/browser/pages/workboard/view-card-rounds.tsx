/** @jsxImportSource @solidjs/web */
import { For, Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import type { WorkboardNodeDecision, WorkboardNodeRound } from "../../lib/workboard/index.ts";

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

/** What each node ticket round decided, newest round first; its changes have their own tab. */
export function NodeRounds(props: { rounds: readonly WorkboardNodeRound[] | undefined }) {
  const decided = () =>
    (props.rounds?.filter((entry) => entry.decisions?.length) ?? []).toReversed();
  return (
    <For each={decided()} keyed={(entry) => entry.round}>
      {(entry) => (
        <section class="workboard-detail__section workboard-round">
          <h3>
            {entry().round === 0
              ? t("workboard.roundFirst")
              : t("workboard.roundRework", { number: String(entry().round) })}
          </h3>
          <Decisions decisions={entry().decisions ?? []} />
        </section>
      )}
    </For>
  );
}
