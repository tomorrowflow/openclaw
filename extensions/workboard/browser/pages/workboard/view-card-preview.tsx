/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import { retryWorkboardPreview, type WorkboardCard } from "../../lib/workboard/index.ts";
import { getCardActionState } from "./view-card-actions.tsx";
import { workboardMutationContext, type WorkboardProps } from "./view-helpers.tsx";

type CardPreview = NonNullable<WorkboardCard["preview"]>;

function previewStatus(preview: CardPreview): string {
  const values = { node: preview.nodeId, head: preview.headCommit.slice(0, 8) };
  if (preview.state === "starting") {
    return t("workboard.previewStarting", values);
  }
  return preview.state === "up"
    ? t("workboard.previewUp", values)
    : t("workboard.previewFailed", values);
}

/**
 * The Preview tab: the reviewed head running on its node, linked on the
 * tailnet once up; a failed start shows its error and, to a writer, Retry.
 */
export function PreviewPanel(props: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  preview: CardPreview;
  active: boolean;
}) {
  const action = () => getCardActionState(props.workboard, props.card);
  return (
    <section
      class="workboard-detail__tabpanel workboard-detail__preview"
      id="workboard-detail-panel-preview"
      role="tabpanel"
      aria-labelledby="workboard-detail-tab-preview"
      tabindex="0"
      hidden={!props.active}
    >
      <p class="workboard-preview__status" data-preview-state={props.preview.state}>
        {previewStatus(props.preview)}
      </p>
      <Show when={props.preview.state === "failed" ? props.preview.error : undefined}>
        {(error) => <p class="workboard-preview__error">{error()}</p>}
      </Show>
      <div class="workboard-preview__actions">
        <Show when={props.preview.state === "up" ? props.preview.url : undefined}>
          {(url) => (
            <a
              class="btn primary"
              href={url()}
              target="_blank"
              rel="noopener"
              title={url()}
              data-preview-action="open"
            >
              {t("workboard.previewOpen")}
            </a>
          )}
        </Show>
        <Show when={props.preview.state === "failed" && action().writable}>
          <button
            class="btn"
            type="button"
            data-preview-action="retry"
            title={t("workboard.previewRetryTitle")}
            disabled={action().busy}
            onClick={() =>
              void retryWorkboardPreview({
                ...workboardMutationContext(props.workboard),
                cardId: props.card.id,
              })
            }
          >
            {t("workboard.previewRetry")}
          </button>
        </Show>
      </div>
    </section>
  );
}
