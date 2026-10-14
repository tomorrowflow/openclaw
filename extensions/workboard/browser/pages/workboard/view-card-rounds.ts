import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  WorkboardNodeChanges,
  WorkboardNodeDecision,
  WorkboardNodeRound,
} from "../../lib/workboard/index.ts";

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

function renderChanges(changes: WorkboardNodeChanges) {
  const widest = Math.max(
    1,
    ...changes.files.map((file) => ("binary" in file ? 0 : file.added + file.deleted)),
  );
  const unlisted = changes.totals.files - changes.files.length;
  return html`<h4>
      ${t("workboard.roundChangedFiles")}
      <span class="workboard-round__totals">
        ${t("workboard.roundChangeTotals", {
          files: String(changes.totals.files),
          added: String(changes.totals.added),
          deleted: String(changes.totals.deleted),
        })}
      </span>
    </h4>
    <ul class="workboard-round__files">
      ${changes.files.map(
        (file) => html`<li>
          <code>${file.path}</code>
          ${
            "binary" in file
              ? html`<span class="workboard-round__counts">${t("workboard.roundBinary")}</span>`
              : html`<span class="workboard-round__counts">
                    <span class="workboard-round__added">+${file.added}</span>
                    <span class="workboard-round__deleted">−${file.deleted}</span>
                  </span>
                  <span class="workboard-round__bar" aria-hidden="true">
                    <span
                      class="workboard-round__bar-added"
                      style=${`inline-size: ${(file.added / widest) * 100}%`}
                    ></span>
                    <span
                      class="workboard-round__bar-deleted"
                      style=${`inline-size: ${(file.deleted / widest) * 100}%`}
                    ></span>
                  </span>`
          }
          ${
            file.previousPath
              ? html`<span class="workboard-round__renamed">
                  ${t("workboard.roundRenamedFrom", { path: file.previousPath })}
                </span>`
              : nothing
          }
        </li>`,
      )}
    </ul>
    ${
      unlisted > 0
        ? html`<p class="workboard-round__more">
            ${t("workboard.roundMoreFiles", { count: String(unlisted) })}
          </p>`
        : nothing
    }`;
}

/** What each node ticket round decided and changed, newest round first. */
export function renderNodeRounds(rounds: readonly WorkboardNodeRound[] | undefined) {
  if (!rounds?.length) {
    return nothing;
  }
  return rounds.toReversed().map(
    (entry) => html`<section class="workboard-detail__section workboard-round">
      <h3>
        ${
          entry.round === 0
            ? t("workboard.roundFirst")
            : t("workboard.roundRework", { number: String(entry.round) })
        }
      </h3>
      ${entry.changes ? renderChanges(entry.changes) : nothing}
      ${entry.decisions?.length ? renderDecisions(entry.decisions) : nothing}
    </section>`,
  );
}
