/** @jsxImportSource @solidjs/web */
import type { WorkboardRunAttempt, WorkboardProof } from "@openclaw/workboard-contract";
import { For, Show, createMemo } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { WorkboardCard, WorkboardDependencyState } from "../../lib/workboard/index.ts";
import { formatStatusLabel, formatUpdatedTime } from "./view-helpers.tsx";

/** Opens a card or the card's run from the technical details; absent when not reachable. */
export type DetailNavigation = {
  /** A card the drawer can show; archived cards only while archived cards are shown. */
  readonly resolveCard: (cardId: string) => WorkboardCard | undefined;
  readonly openCard: (card: WorkboardCard) => void;
  readonly openSession?: () => void;
  /** Opens the card's page in the transcript viewer; called from the click itself. */
  readonly openTranscript?: () => void;
};

function CardLink(props: { label: string; onOpen: () => void }) {
  return (
    <button type="button" class="workboard-detail__card-link" onClick={() => props.onOpen()}>
      {props.label}
    </button>
  );
}

function CardReference(props: { cardId: string; fallback: string; navigation: DetailNavigation }) {
  return (
    <Show
      when={props.navigation.resolveCard(props.cardId)}
      fallback={<span>{props.fallback}</span>}
    >
      {(target) => (
        <CardLink label={target().title} onOpen={() => props.navigation.openCard(target())} />
      )}
    </Show>
  );
}

export function DependencyDetailList(props: {
  dependencies: WorkboardDependencyState;
  navigation: DetailNavigation;
}) {
  return (
    <Show when={props.dependencies.parents.length}>
      <section class="workboard-detail__section">
        <h3>{t("workboard.dependencies")}</h3>
        <ul class="workboard-detail__list workboard-detail__dependencies">
          <For each={props.dependencies.parents} keyed={(parent) => parent.id}>
            {(parent) => (
              <li class={parent().done ? "is-done" : "is-blocked"}>
                {parent().done ? (
                  <span class="workboard-detail__dependency-spacer" />
                ) : (
                  icons.alertTriangle
                )}
                <CardReference
                  cardId={parent().id}
                  fallback={parent().title}
                  navigation={props.navigation}
                />
                <span>
                  {parent().missing
                    ? t("workboard.dependencyStatusMissing")
                    : parent().status
                      ? formatStatusLabel(parent().status!)
                      : t("workboard.unknownStatus")}
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

export function DetailRow(props: { label: string; value: unknown }) {
  const text = () =>
    typeof props.value === "string" || typeof props.value === "number"
      ? String(props.value).trim()
      : "";
  return (
    <Show when={text()}>
      <div class="workboard-detail__row">
        <span>{props.label}</span>
        <strong>{text()}</strong>
      </div>
    </Show>
  );
}

function SessionRow(props: { label: string; value: string | undefined; onOpen?: () => void }) {
  return (
    <Show
      when={props.onOpen && props.value?.trim()}
      fallback={<DetailRow label={props.label} value={props.value} />}
    >
      {(text) => (
        <div class="workboard-detail__row">
          <span>{props.label}</span>
          <button
            type="button"
            class="workboard-detail__card-link"
            title={t("workboard.openSession")}
            onClick={() => props.onOpen?.()}
          >
            {text()}
          </button>
        </div>
      )}
    </Show>
  );
}

function TranscriptRow(props: { onOpen: (() => void) | undefined }) {
  return (
    <Show when={props.onOpen}>
      <div class="workboard-detail__row">
        <span>{t("workboard.fieldTranscript")}</span>
        <button type="button" class="workboard-detail__card-link" onClick={() => props.onOpen?.()}>
          {t("workboard.openTranscript")}
        </button>
      </div>
    </Show>
  );
}

function safeExternalUrl(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

type DetailLink = NonNullable<NonNullable<WorkboardCard["metadata"]>["links"]>[number];

function LinkEntry(props: { link: DetailLink; navigation: DetailNavigation }) {
  const target = () =>
    props.link.targetCardId ? props.navigation.resolveCard(props.link.targetCardId) : undefined;
  const url = () => (props.link.url ? safeExternalUrl(props.link.url) : undefined);
  const prefix = () => joinDetailParts(props.link.type, props.link.title);
  return (
    <li>
      <Show
        when={target()}
        fallback={
          <Show
            when={url()}
            fallback={joinDetailParts(
              props.link.type,
              props.link.title,
              props.link.targetCardId,
              props.link.url,
            )}
          >
            {(href) => (
              <>
                {prefix() ? `${prefix()} - ` : ""}
                <a href={href()} target="_blank" rel="noopener noreferrer">
                  {href()}
                </a>
              </>
            )}
          </Show>
        }
      >
        {(card) => (
          <>
            {props.link.type} -{" "}
            <CardLink label={card().title} onOpen={() => props.navigation.openCard(card())} />
          </>
        )}
      </Show>
    </li>
  );
}

function LinkDetailList(props: { links: readonly DetailLink[]; navigation: DetailNavigation }) {
  return (
    <Show when={props.links.length}>
      <section class="workboard-detail__section">
        <h3>{t("workboard.badgeLinks", { count: String(props.links.length) })}</h3>
        <ol class="workboard-detail__list">
          <For each={props.links} keyed={false}>
            {(link) => <LinkEntry link={link()} navigation={props.navigation} />}
          </For>
        </ol>
      </section>
    </Show>
  );
}

function DetailList(props: { title: string; values: readonly string[] }) {
  const entries = createMemo(() =>
    props.values
      .map((value, index) => ({ index, text: value.trim() }))
      .filter((entry) => entry.text),
  );
  return (
    <Show when={entries().length}>
      <section class="workboard-detail__section">
        <h3>{props.title}</h3>
        <ol class="workboard-detail__list">
          <For each={entries()} keyed={(entry) => entry.index}>
            {(entry) => <li>{entry().text}</li>}
          </For>
        </ol>
      </section>
    </Show>
  );
}

function DetailTime(props: { value: number | undefined }) {
  const time = createMemo(() => {
    const value = props.value;
    const label = formatUpdatedTime(value);
    return value === undefined || !label
      ? undefined
      : { label, iso: new Date(value).toISOString() };
  });
  return (
    <Show when={time()}>
      {(value) => (
        <time class="workboard-detail__record-date" datetime={value().iso}>
          {value().label}
        </time>
      )}
    </Show>
  );
}

const attemptStatusKeys: Record<WorkboardRunAttempt["status"], string> = {
  running: "workboard.lifecycleRunning",
  succeeded: "workboard.lifecycleDone",
  failed: "workboard.lifecycleFailed",
  blocked: "workboard.status.blocked",
  stopped: "workboard.lifecycleStopped",
};

function AttemptDetails(props: { attempts: readonly WorkboardRunAttempt[] }) {
  return (
    <Show when={props.attempts.length}>
      <section class="workboard-detail__section">
        <h3>{t("workboard.badgeAttempts", { count: String(props.attempts.length) })}</h3>
        <ol class="workboard-detail__records">
          <For each={props.attempts} keyed={(entry) => entry.id}>
            {(entry, index) => (
              <li>
                <div class="workboard-detail__record-heading">
                  <strong>
                    {t("workboard.detailAttemptTitle", { number: String(index() + 1) })}
                  </strong>
                  <span>{t(attemptStatusKeys[entry().status])}</span>
                </div>
                {entry().model ? <p>{entry().model}</p> : undefined}
                {entry().sessionKey ? (
                  <p class="workboard-detail__record-reference">{entry().sessionKey}</p>
                ) : undefined}
                {entry().error ? <p>{formatUiExternalText(entry().error)}</p> : undefined}
                <div class="workboard-detail__record-date">
                  <DetailTime value={entry().startedAt} />
                  {formatUpdatedTime(entry().startedAt) && formatUpdatedTime(entry().endedAt)
                    ? " → "
                    : undefined}
                  <DetailTime value={entry().endedAt} />
                </div>
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  );
}

const proofStatusKeys: Record<WorkboardProof["status"], string> = {
  passed: "workboard.proofPassed",
  failed: "workboard.lifecycleFailed",
  skipped: "workboard.proofSkipped",
  unknown: "workboard.proofUnknown",
};

function ProofDetails(props: { proof: readonly WorkboardProof[] }) {
  return (
    <Show when={props.proof.length}>
      <section class="workboard-detail__section">
        <h3>{t("workboard.detailProof")}</h3>
        <ol class="workboard-detail__records">
          <For each={props.proof} keyed={(entry) => entry.id}>
            {(entry) => (
              <li>
                <div class="workboard-detail__record-heading">
                  <strong>{entry().label || t("workboard.detailProof")}</strong>
                  <span>{t(proofStatusKeys[entry().status])}</span>
                </div>
                {entry().command ? <code>{entry().command}</code> : undefined}
                {entry().url ? (
                  <p class="workboard-detail__record-reference">{entry().url}</p>
                ) : undefined}
                {entry().note ? <p>{entry().note}</p> : undefined}
                <DetailTime value={entry().createdAt} />
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  );
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

export function technicalDetailsData(card: WorkboardCard, linkedSessionKey: string | undefined) {
  const links = [...(card.metadata?.links ?? [])];
  const attempts = [...(card.metadata?.attempts ?? [])];
  const proof = [...(card.metadata?.proof ?? [])];
  const automation = card.metadata?.automation;
  const metadata = card.metadata;
  const notifications = [...(metadata?.notifications ?? [])];
  const runId = card.runId ?? card.execution?.runId;
  const metadataFields: Array<readonly [string, string | number | undefined]> = [
    [t("workboard.detailTenant"), automation?.tenant],
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
  return {
    linkedSessionKey,
    runId,
    links,
    attempts,
    proof,
    automation,
    metadataFields,
    notifications,
    detailSections,
    hasTechnicalDetails,
  };
}

export function TechnicalDetails(props: {
  data: ReturnType<typeof technicalDetailsData>;
  active: boolean;
  navigation: DetailNavigation;
}) {
  return (
    <Show when={props.data.hasTechnicalDetails}>
      <section
        class="workboard-detail__tabpanel workboard-detail__technical"
        id="workboard-detail-panel-details"
        role="tabpanel"
        aria-labelledby="workboard-detail-tab-details"
        tabindex="0"
        hidden={!props.active}
      >
        <h3>{t("workboard.detailTechnical")}</h3>
        <div class="workboard-detail__technical-properties">
          <SessionRow
            label={t("workboard.fieldSession")}
            value={props.data.linkedSessionKey}
            onOpen={props.navigation.openSession}
          />
          <TranscriptRow onOpen={props.navigation.openTranscript} />
          <SessionRow
            label={t("workboard.detailRun")}
            value={props.data.runId}
            onOpen={props.navigation.openSession}
          />
          <For each={props.data.metadataFields} keyed={(field) => field[0]}>
            {(field) => <DetailRow label={field()[0]} value={field()[1]} />}
          </For>
        </div>
        <Show when={props.data.notifications.length}>
          <section class="workboard-detail__section">
            <h3>{t("workboard.detailNotifications")}</h3>
            <ol class="workboard-detail__list">
              <For each={props.data.notifications} keyed={(notification) => notification.id}>
                {(notification) => <li>{formatUiExternalText(notification().message)}</li>}
              </For>
            </ol>
          </section>
        </Show>
        <AttemptDetails attempts={props.data.attempts} />
        <ProofDetails proof={props.data.proof} />
        <LinkDetailList links={props.data.links} navigation={props.navigation} />
        <For each={props.data.detailSections} keyed={(section) => section[0]}>
          {(section) => <DetailList title={section()[0]} values={section()[1]} />}
        </For>
      </section>
    </Show>
  );
}
