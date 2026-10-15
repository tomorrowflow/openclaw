import type { WorkboardRunAttempt, WorkboardProof } from "@openclaw/workboard-contract";
import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { WorkboardCard, WorkboardDependencyState } from "../../lib/workboard/index.ts";
import { formatStatusLabel, formatUpdatedTime } from "./view-helpers.ts";

/** Opens a card or the card's run from the technical details; absent when not reachable. */
export type DetailNavigation = {
  /** A card the drawer can show; archived cards only while archived cards are shown. */
  readonly resolveCard: (cardId: string) => WorkboardCard | undefined;
  readonly openCard: (card: WorkboardCard) => void;
  readonly openSession?: () => void;
};

export function renderDependencyDetailList(
  dependencies: WorkboardDependencyState,
  navigation: DetailNavigation,
) {
  if (dependencies.parents.length === 0) {
    return nothing;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${t("workboard.dependencies")}</h3>
      <ul class="workboard-detail__list workboard-detail__dependencies">
        ${dependencies.parents.map(
          (parent) => html`
            <li class=${parent.done ? "is-done" : "is-blocked"}>
              ${
                parent.done
                  ? html`<span class="workboard-detail__dependency-spacer"></span>`
                  : icons.alertTriangle
              }
              ${renderCardReference(parent.id, parent.title, navigation)}
              <span>
                ${
                  parent.missing
                    ? t("workboard.dependencyStatusMissing")
                    : parent.status
                      ? formatStatusLabel(parent.status)
                      : t("workboard.unknownStatus")
                }
              </span>
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}

export function renderDetailRow(label: string, value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return nothing;
  }
  const text = String(value).trim();
  if (!text) {
    return nothing;
  }
  return html`
    <div class="workboard-detail__row">
      <span>${label}</span>
      <strong>${text}</strong>
    </div>
  `;
}

function renderCardLink(label: string, open: () => void) {
  return html`<button type="button" class="workboard-detail__card-link" @click=${open}>
    ${label}
  </button>`;
}

function renderCardReference(cardId: string, fallback: string, navigation: DetailNavigation) {
  const target = navigation.resolveCard(cardId);
  return target
    ? renderCardLink(target.title, () => navigation.openCard(target))
    : html`<span>${fallback}</span>`;
}

function renderSessionRow(label: string, value: string | undefined, openSession?: () => void) {
  const text = value?.trim();
  if (!text || !openSession) {
    return renderDetailRow(label, value);
  }
  return html`
    <div class="workboard-detail__row">
      <span>${label}</span>
      <button
        type="button"
        class="workboard-detail__card-link"
        title=${t("workboard.openSession")}
        @click=${openSession}
      >
        ${text}
      </button>
    </div>
  `;
}

function safeExternalUrl(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function renderLinkDetailList(
  links: NonNullable<NonNullable<WorkboardCard["metadata"]>["links"]>,
  navigation: DetailNavigation,
) {
  if (links.length === 0) {
    return nothing;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${t("workboard.badgeLinks", { count: String(links.length) })}</h3>
      <ol class="workboard-detail__list">
        ${links.map((link) => {
          const target = link.targetCardId ? navigation.resolveCard(link.targetCardId) : undefined;
          if (target) {
            const open = () => navigation.openCard(target);
            return html`<li>${link.type} - ${renderCardLink(target.title, open)}</li>`;
          }
          const url = link.url ? safeExternalUrl(link.url) : undefined;
          if (url) {
            const prefix = joinDetailParts(link.type, link.title);
            const anchor = html`<a href=${url} target="_blank" rel="noopener noreferrer"
              >${url}</a
            >`;
            return html`<li>${prefix ? `${prefix} - ` : ""}${anchor}</li>`;
          }
          const text = joinDetailParts(link.type, link.title, link.targetCardId, link.url);
          return html`<li>${text}</li>`;
        })}
      </ol>
    </section>
  `;
}

function renderDetailList(title: string, values: readonly string[]) {
  const entries = values.map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <section class="workboard-detail__section">
      <h3>${title}</h3>
      <ol class="workboard-detail__list">
        ${entries.map((entry) => html`<li>${entry}</li>`)}
      </ol>
    </section>
  `;
}

function renderDetailTime(value: number | undefined) {
  const label = formatUpdatedTime(value);
  if (value === undefined || !label) {
    return nothing;
  }
  return html`<time class="workboard-detail__record-date" datetime=${new Date(value).toISOString()}
    >${label}</time
  >`;
}

function renderAttemptDetails(attempts: readonly WorkboardRunAttempt[]) {
  if (!attempts.length) {
    return nothing;
  }
  const statusKeys: Record<WorkboardRunAttempt["status"], string> = {
    running: "workboard.lifecycleRunning",
    succeeded: "workboard.lifecycleDone",
    failed: "workboard.lifecycleFailed",
    blocked: "workboard.status.blocked",
    stopped: "workboard.lifecycleStopped",
  };
  return html`<section class="workboard-detail__section">
    <h3>${t("workboard.badgeAttempts", { count: String(attempts.length) })}</h3>
    <ol class="workboard-detail__records">
      ${attempts.map((entry, index) => {
        const started = renderDetailTime(entry.startedAt);
        const ended = renderDetailTime(entry.endedAt);
        return html`<li>
          <div class="workboard-detail__record-heading">
            <strong>${t("workboard.detailAttemptTitle", { number: String(index + 1) })}</strong>
            <span>${t(statusKeys[entry.status])}</span>
          </div>
          ${entry.model ? html`<p>${entry.model}</p>` : nothing}
          ${
            entry.sessionKey
              ? html`<p class="workboard-detail__record-reference">${entry.sessionKey}</p>`
              : nothing
          }
          ${entry.error ? html`<p>${formatUiExternalText(entry.error)}</p>` : nothing}
          <div class="workboard-detail__record-date">
            ${started}${started !== nothing && ended !== nothing ? " → " : nothing}${ended}
          </div>
        </li>`;
      })}
    </ol>
  </section>`;
}

function renderProofDetails(proof: readonly WorkboardProof[]) {
  if (!proof.length) {
    return nothing;
  }
  const statusKeys: Record<WorkboardProof["status"], string> = {
    passed: "workboard.proofPassed",
    failed: "workboard.lifecycleFailed",
    skipped: "workboard.proofSkipped",
    unknown: "workboard.proofUnknown",
  };
  return html`<section class="workboard-detail__section">
    <h3>${t("workboard.detailProof")}</h3>
    <ol class="workboard-detail__records">
      ${proof.map(
        (entry) => html`<li>
          <div class="workboard-detail__record-heading">
            <strong>${entry.label || t("workboard.detailProof")}</strong>
            <span>${t(statusKeys[entry.status])}</span>
          </div>
          ${entry.command ? html`<code>${entry.command}</code>` : nothing}
          ${
            entry.url
              ? html`<p class="workboard-detail__record-reference">${entry.url}</p>`
              : nothing
          }
          ${entry.note ? html`<p>${entry.note}</p>` : nothing} ${renderDetailTime(entry.createdAt)}
        </li>`,
      )}
    </ol>
  </section>`;
}

function joinDetailParts(...values: unknown[]): string {
  return values.filter(Boolean).join(" - ");
}

function detailValues<T>(entries: readonly T[], ...fields: Array<keyof T>): string[] {
  return entries.map((entry) => joinDetailParts(...fields.map((field) => entry[field])));
}

function getDetailSections(card: WorkboardCard) {
  const artifacts = card.metadata?.artifacts ?? [];
  const attachments = card.metadata?.attachments ?? [];
  const diagnostics = card.metadata?.diagnostics ?? [];
  const workerLogs = card.metadata?.workerLogs ?? [];
  const workerProtocol = card.metadata?.workerProtocol;
  const detailSections: Array<readonly [string, readonly string[]]> = [
    [
      t("workboard.badgeArtifacts", { count: String(artifacts.length) }),
      detailValues(artifacts, "label", "url", "path", "mimeType"),
    ],
    [
      t("workboard.badgeAttachments", { count: String(attachments.length) }),
      detailValues(attachments, "fileName", "mimeType", "note"),
    ],
    [
      t("workboard.detailDiagnostics"),
      diagnostics.map((entry) =>
        joinDetailParts(
          `${entry.severity}: ${formatUiExternalText(entry.title)}`,
          formatUiExternalText(entry.detail),
          t("workboard.detailOccurrences", { count: String(entry.count) }),
          t("workboard.detailFirstSeen", { time: formatUpdatedTime(entry.firstSeenAt) }),
          t("workboard.detailLastSeen", { time: formatUpdatedTime(entry.lastSeenAt) }),
        ),
      ),
    ],
    [
      t("workboard.detailWorkerLogs"),
      workerLogs.map((entry) => `${entry.level}: ${formatUiExternalText(entry.message)}`),
    ],
    [
      t("workboard.detailWorkerProtocol"),
      workerProtocol
        ? [
            workerProtocol.state,
            formatUiExternalText(workerProtocol.detail),
            workerProtocol.updatedAt
              ? t("workboard.detailUpdatedValue", {
                  time: formatUpdatedTime(workerProtocol.updatedAt),
                })
              : "",
          ]
        : [],
    ],
  ];
  return detailSections;
}

export function renderTechnicalDetails(
  card: WorkboardCard,
  linkedSessionKey: string | undefined,
  active: boolean,
  navigation: DetailNavigation,
) {
  const links = card.metadata?.links ?? [];
  const attempts = card.metadata?.attempts ?? [];
  const proof = card.metadata?.proof ?? [];
  const automation = card.metadata?.automation;
  const metadata = card.metadata;
  const notifications = metadata?.notifications ?? [];
  const metadataFields: Array<readonly [string, string | number | undefined]> = [
    [
      t("workboard.detailTemplate"),
      metadata?.templateId ? t(`workboard.template.${metadata.templateId}`) : undefined,
    ],
    [t("workboard.detailFailures"), metadata?.failureCount],
    [
      t("workboard.fieldStatus"),
      metadata?.stale
        ? `${t("workboard.badgeStale")}: ${formatUiExternalText(metadata.stale.reason)}`
        : undefined,
    ],
    [
      t("workboard.detailClaim"),
      metadata?.claim ? formatUiExternalText(metadata.claim.ownerId) : undefined,
    ],
    [
      t("workboard.detailHeartbeat"),
      metadata?.claim ? formatUpdatedTime(metadata.claim.lastHeartbeatAt) : undefined,
    ],
  ];
  const detailSections = getDetailSections(card);
  const hasTechnicalDetails = Boolean(
    linkedSessionKey ||
    card.runId ||
    card.execution?.runId ||
    automation?.tenant ||
    metadataFields.some(([, value]) => value !== undefined && value !== "") ||
    notifications.length ||
    attempts.length ||
    proof.length ||
    links.length ||
    detailSections.some(([, values]) => values.some((value) => value.trim())),
  );
  if (!hasTechnicalDetails) {
    return nothing;
  }
  return html`<section
    class="workboard-detail__tabpanel workboard-detail__technical"
    id="workboard-detail-panel-details"
    role="tabpanel"
    aria-labelledby="workboard-detail-tab-details"
    tabindex="0"
    ?hidden=${!active}
  >
    <h3>${t("workboard.detailTechnical")}</h3>
    <div class="workboard-detail__technical-properties">
      ${renderSessionRow(t("workboard.fieldSession"), linkedSessionKey, navigation.openSession)}
      ${renderSessionRow(
        t("workboard.detailRun"),
        card.runId ?? card.execution?.runId,
        navigation.openSession,
      )}
      ${renderDetailRow(t("workboard.detailTenant"), automation?.tenant)}
      ${metadataFields.map(([label, value]) => renderDetailRow(label, value))}
    </div>
    ${
      notifications.length
        ? html`<section class="workboard-detail__section">
            <h3>${t("workboard.detailNotifications")}</h3>
            <ol class="workboard-detail__list">
              ${notifications.map(
                (notification) => html`<li>${formatUiExternalText(notification.message)}</li>`,
              )}
            </ol>
          </section>`
        : nothing
    }
    ${renderAttemptDetails(attempts)} ${renderProofDetails(proof)}
    ${renderLinkDetailList(links, navigation)}
    ${detailSections.map(([title, values]) => renderDetailList(title, values))}
  </section>`;
}
