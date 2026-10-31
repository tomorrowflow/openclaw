/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import {
  addWorkboardCardComment,
  getWorkboardState,
  type WorkboardCard,
} from "../../lib/workboard/index.ts";
import { moveCardToStatus } from "./view-card-actions.tsx";
import {
  workboardMutationContext,
  workboardViewState,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { liveInputValue } from "./view-input-value.ts";

/** The detail drawer's operator note box; a card waiting on an answer can also resume in one click. */
export function CardCommentCompose(
  props: WorkboardProps & { card: WorkboardCard; busy: boolean; archived: boolean },
) {
  const state = workboardViewState(() => props);
  const noteValue = liveInputValue(() => state().detailCommentBody);
  const empty = () => !state().detailCommentBody.trim();
  // Questions in review and blocked cards wait on the operator; todo resumes or re-runs them.
  const awaitsAnswer = () =>
    !props.archived &&
    ((props.card.status === "review" && props.card.stage?.kind === "questions") ||
      props.card.status === "blocked");
  const addNote = () =>
    addWorkboardCardComment({
      ...workboardMutationContext(props),
      cardId: props.card.id,
      body: state().detailCommentBody,
    });
  const answerAndResume = async () => {
    if (!(await addNote())) {
      return;
    }
    const saved = getWorkboardState(props.host).cards.find((entry) => entry.id === props.card.id);
    if (saved) {
      await moveCardToStatus(props, saved, "todo");
    }
  };
  return (
    <div class="workboard-detail__comment-compose">
      <textarea
        class="settings-input workboard-detail__note"
        aria-label={t("workboard.detailOperatorNotes")}
        rows="2"
        maxlength="8000"
        placeholder={t("workboard.detailNotePlaceholder")}
        ref={noteValue}
        disabled={props.busy}
        onInput={(event) => {
          state().detailCommentBody = event.currentTarget.value;
          state().detailCommentDrafts.set(props.card.id, state().detailCommentBody);
          props.onRequestUpdate?.();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) {
            return;
          }
          event.preventDefault();
          if (!props.busy && !empty()) {
            void addNote();
          }
        }}
      />
      <div class="workboard-detail__comment-actions">
        <button
          class="btn"
          type="button"
          disabled={props.busy || empty()}
          onClick={() => void addNote()}
        >
          {t("workboard.detailAddNote")}
        </button>
        <Show when={awaitsAnswer()}>
          <button
            class="btn primary"
            type="button"
            data-card-action="answer-resume"
            title={t("workboard.detailAnswerResumeTitle")}
            disabled={props.busy || empty()}
            onClick={() => void answerAndResume()}
          >
            {t("workboard.detailAnswerResume")}
          </button>
        </Show>
      </div>
    </div>
  );
}
