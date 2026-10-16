import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { WorkboardNodeDecision, WorkboardNodeRound } from "../../lib/workboard/index.ts";

function renderDecisions(decisions: readonly WorkboardNodeDecision[]) {
  return html`<h4>${t("workboard.roundDecisions")}</h4>
    <ol class="workboard-round__decisions">
      ${decisions.map(
        (entry) => html`<li>
          <span class="workboard-round__phase">${entry.phase}</span>
          <div class="workboard-round__decision">
            <strong>${entry.decision}</strong>
            ${entry.why ? html`<p>${entry.why}</p>` : nothing}
            ${
              entry.evidence || entry.result || entry.ts
                ? html`<p class="workboard-round__meta">
                    ${entry.evidence ? html`<code>${entry.evidence}</code>` : nothing}
                    ${entry.result ? html`<span>${entry.result}</span>` : nothing}
                    ${entry.ts ? html`<time>${entry.ts}</time>` : nothing}
                  </p>`
                : nothing
            }
          </div>
        </li>`,
      )}
    </ol>`;
}

/** What each node ticket round decided, newest round first; its changes have their own tab. */
export function renderNodeRounds(rounds: readonly WorkboardNodeRound[] | undefined) {
  const decided = rounds?.filter((entry) => entry.decisions?.length) ?? [];
  if (!decided.length) {
    return nothing;
  }
  return decided.toReversed().map(
    (entry) => html`<section class="workboard-detail__section workboard-round">
      <h3>
        ${
          entry.round === 0
            ? t("workboard.roundFirst")
            : t("workboard.roundRework", { number: String(entry.round) })
        }
      </h3>
      ${entry.decisions ? renderDecisions(entry.decisions) : nothing}
    </section>`,
  );
}
