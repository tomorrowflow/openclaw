/** @jsxImportSource @solidjs/web */
import { For, Show, createEffect, createMemo, merge } from "solid-js";
import {
  AgentAvatar,
  SessionSummary,
  Dialog,
  Markdown,
} from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { WorkboardErrorToast } from "../../components/toast.tsx";
import { t } from "../../i18n/index.ts";
import { openTranscriptViewer } from "../../lib/transcript-viewer.ts";
import {
  workboardCardBoardId,
  WORKBOARD_ALL_BOARDS_FILTER,
} from "../../lib/workboard/board-filter.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import { canRestartWorkboardNodeTicket } from "../../lib/workboard/execution.ts";
import {
  addWorkboardCardComment,
  getWorkboardDependencyState,
  getWorkboardLifecycle,
  getWorkboardState,
  grillWorkboardQuestions,
  type WorkboardCard,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";
import { formatError } from "../../lib/workboard/normalization-utils.ts";
import { cardAgentLabel } from "./agent-filter.ts";
import { automationDetailFields, BoardAutomation } from "./view-automation.tsx";
import { getCardActionState, CardAction, StartExecutionButton } from "./view-card-actions.tsx";
import { hasCardChanges } from "./view-card-changes.tsx";
import { CardPullRequest, CardStage } from "./view-card-content.tsx";
import {
  DependencyDetailList,
  DetailRow,
  TechnicalDetails,
  technicalDetailsData,
  type DetailNavigation,
} from "./view-card-detail-records.tsx";
import { DetailTabs, detailScreenshots, NodeTicketTabPanels } from "./view-card-detail-tabs.tsx";
import { CardDiscardDialog } from "./view-card-modal.tsx";
import { NodeRounds } from "./view-card-rounds.tsx";
import { CardSessionHeading } from "./view-card-session-heading.tsx";
import {
  formatEventLabel,
  formatLifecycle,
  formatPriorityLabel,
  workboardErrorMessage,
  workboardMutationContext,
  workboardViewState,
  renderPriorityIcon,
  formatStatusLabel,
  formatUpdatedTime,
  type WorkboardProps,
} from "./view-helpers.tsx";
import {
  InlineAgent,
  InlinePriority,
  InlineStatus,
  InlineText,
  type WorkboardInlineText,
} from "./view-inline-properties.tsx";
import { liveInputValue } from "./view-input-value.ts";
import { closeWorkboardPopoverOnAction, workboardPopoverRef } from "./view-popover.ts";
import { workboardScrollFadeRef } from "./view-scroll-fade.ts";

export const workboardCardDetailDrawerId = "workboard-card-detail-drawer";
const workboardCardDetailTitleId = "workboard-card-detail-title";

const detailDrawerRefs = new WeakMap<WorkboardUiState, { value?: HTMLElement }>();
const inlineDiscardOpen = new WeakMap<WorkboardUiState, () => void>();

export function openCardDetails(state: WorkboardUiState, card: WorkboardCard) {
  inlineDiscardOpen.delete(state);
  state.detailCardId = card.id;
  // A grilling card opens on its Grilling tab, which leads to the grill session where it happens.
  state.detailTab = card.stage?.kind === "grilling" ? "grilling" : "overview";
  state.detailCommentBody = state.detailCommentDrafts.get(card.id) ?? "";
}

function closeCardDetails(state: WorkboardUiState) {
  inlineDiscardOpen.delete(state);
  state.detailCardId = null;
  state.detailTab = "overview";
  state.detailCommentBody = "";
}

export function getVisibleDetailCard(state: WorkboardUiState): WorkboardCard | null {
  if (!state.detailCardId || state.draftOpen) {
    return null;
  }
  const card = state.cards.find((entry) => entry.id === state.detailCardId) ?? null;
  if (card?.metadata?.archivedAt && !state.showArchived) {
    const editors = detailDrawerRefs
      .get(state)
      ?.value?.querySelectorAll<WorkboardInlineText>("workboard-inline-text");
    const hasDraft = [...(editors ?? [])].some(
      (editor) =>
        editor.draftCardId === card.id && (editor.hasUnsavedChanges || editor.pendingSave),
    );
    if (!hasDraft) {
      return null;
    }
  }
  return card;
}

export function CardDetailsPanel(props: WorkboardProps) {
  const card = () => {
    void props.revision;
    return getVisibleDetailCard(getWorkboardState(props.host));
  };
  return (
    <Show when={card()}>{(visible) => <CardDetailsContent {...props} card={visible()} />}</Show>
  );
}

function CardDetailsContent(props: WorkboardProps & { card: WorkboardCard }) {
  const initialActiveElement = document.activeElement;
  const initialReturnFocusTarget =
    initialActiveElement instanceof HTMLElement && initialActiveElement !== document.body
      ? initialActiveElement
      : undefined;
  const state = workboardViewState(() => props);
  const noteValue = liveInputValue(() => state().detailCommentBody);
  const visibleError = () => workboardErrorMessage(state(), props.pageError);
  const card = () => {
    void props.revision;
    return props.card;
  };
  const drawer: { value: HTMLElement | undefined } = { value: undefined };
  const drawerOwner = createMemo(() => getWorkboardState(props.host));
  createEffect(drawerOwner, (detailState) => {
    detailDrawerRefs.set(detailState, drawer);
    return () => {
      if (detailDrawerRefs.get(detailState) === drawer) {
        detailDrawerRefs.delete(detailState);
        inlineDiscardOpen.delete(detailState);
      }
    };
  });
  const inlineEditors = () => [
    ...(drawer.value?.querySelectorAll<WorkboardInlineText>("workboard-inline-text") ?? []),
  ];
  const requestTransition = (transition: () => void) => {
    const editors = inlineEditors();
    if (editors.some((editor) => editor.pendingSave)) {
      return false;
    }
    if (editors.some((editor) => editor.hasUnsavedChanges)) {
      inlineDiscardOpen.set(state(), transition);
      props.onRequestUpdate?.();
      return false;
    }
    transition();
    return true;
  };
  const dismissDetails = () =>
    requestTransition(() => {
      closeCardDetails(state());
      props.onRequestUpdate?.();
    });
  const navigateAutomation = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const link = event.currentTarget;
    if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self")) {
      return;
    }
    let requesting = true;
    const proceed = requestTransition(() => {
      // Clean clicks retain native navigation. Replay a deferred click only after discard.
      if (!requesting && link.isConnected) {
        link.click();
      }
    });
    requesting = false;
    if (!proceed) {
      event.preventDefault();
    }
  };
  const actionProps = merge(props, {
    onOpenSession: (session: Parameters<WorkboardProps["onOpenSession"]>[0]) => {
      requestTransition(() => props.onOpenSession(session));
    },
  });
  const action = createMemo(() => getCardActionState(props, card()));
  const selectTab = (tab: WorkboardUiState["detailTab"], target: EventTarget | null) => {
    if (tab !== state().detailTab && target instanceof HTMLElement) {
      const body = target
        .closest(".workboard-detail")
        ?.querySelector<HTMLElement>(".workboard-detail__body");
      if (body) {
        body.scrollTop = 0;
      }
    }
    state().detailTab = tab;
    props.onRequestUpdate?.();
  };
  const lifecycle = createMemo(() =>
    getWorkboardLifecycle(card(), props.sessions, props.sessionResolution),
  );
  const formatted = createMemo(() => formatLifecycle(lifecycle(), card()));
  const comments = createMemo(() => [...(card().metadata?.comments ?? [])]);
  const automation = () => card().metadata?.automation;
  const boardId = () => workboardCardBoardId(card());
  const board = () => state().boards.find((entry) => entry.id === boardId());
  const events = createMemo(() => (card().events ?? []).toReversed());
  const dependencies = createMemo(() => getWorkboardDependencyState(card(), state().cards));
  const technical = createMemo(() => technicalDetailsData(card(), action().linkedSessionKey));
  // Opening a portal needs operator.write, so read-only operators get no control that always fails.
  const transcriptViewerPort = () => (props.canWrite === false ? null : props.transcriptViewerPort);
  const navigation: DetailNavigation = {
    resolveCard: (cardId) =>
      state().cards.find(
        (entry) => entry.id === cardId && (!entry.metadata?.archivedAt || state().showArchived),
      ),
    openCard: (target) =>
      requestTransition(() => {
        openCardDetails(state(), target);
        props.onRequestUpdate?.();
      }),
    get openSession() {
      const target = action().sessionTarget;
      return target ? () => actionProps.onOpenSession(target) : undefined;
    },
    get openTranscript() {
      const port = transcriptViewerPort();
      const client = props.client;
      const cardId = card().id;
      return port && client && action().linkedSessionKey
        ? () => {
            openTranscriptViewer(client, port, `/card/${encodeURIComponent(cardId)}`).catch(
              (error: unknown) => {
                state().error = formatError(error);
                props.onRequestUpdate?.();
              },
            );
          }
        : undefined;
    },
  };
  const tabs = () =>
    [
      { id: "overview", label: t("workboard.detailTabOverview") },
      ...(props.detailGrilling && card().grill
        ? [{ id: "grilling", label: t("workboard.detailTabGrilling") } as const]
        : []),
      { id: "activity", label: t("workboard.detailTabActivity") },
      ...(props.detailChanges && hasCardChanges(card())
        ? [{ id: "changes", label: t("workboard.detailTabChanges") } as const]
        : []),
      ...(detailScreenshots(props, card())
        ? [{ id: "screenshots", label: t("workboard.detailTabScreenshots") } as const]
        : []),
      ...(action().sessionTarget
        ? [{ id: "session", label: t("workboard.detailTabSession") } as const]
        : []),
      ...(technical().hasTechnicalDetails
        ? [{ id: "details", label: t("workboard.detailTabDetails") } as const]
        : []),
    ] as const;
  const activeTab = () =>
    tabs().some((tab) => tab.id === state().detailTab) ? state().detailTab : "overview";
  const sessionEmpty = () => lifecycle().state === "unlinked" && !action().linkedSessionKey;
  const visibleAutomationFields = createMemo(() => automationDetailFields(automation()));
  const detailsDialog = (
    <Dialog
      {...{
        returnFocusTarget: initialReturnFocusTarget,
        className: "drawer drawer--floating",
        label: card().title,
        description: lifecycle().session?.displayName ?? formatted().detail,
        style:
          "--openclaw-modal-width: 620px; --openclaw-modal-backdrop-filter: none; --wa-color-overlay-modal: rgba(0, 0, 0, 0.24);",
        onCancel: dismissDetails,
      }}
    >
      <>
        <aside
          id={workboardCardDetailDrawerId}
          class="workboard-detail-drawer"
          ref={(element) => {
            drawer.value = element;
          }}
        >
          <div class="workboard-detail">
            <header class="workboard-detail__header">
              <h2 id={workboardCardDetailTitleId}>
                <span class="sr-only">{t("workboard.detailTitle")}: </span>
                <InlineText
                  owner={props}
                  card={card()}
                  field={"title"}
                  disabled={action().busy}
                  readOnly={!action().writable || action().archived}
                />
              </h2>
              <div class="workboard-detail__header-actions">
                {action().writable ? (
                  <>
                    <button
                      class="btn btn--icon workboard-detail__icon"
                      type="button"
                      popovertarget="workboard-detail-actions"
                      aria-label={t("workboard.cardActions")}
                      aria-haspopup="true"
                      aria-expanded="false"
                    >
                      {icons.moreHorizontal}
                    </button>
                    <div
                      id="workboard-detail-actions"
                      class="workboard-detail__menu"
                      popover="auto"
                      role="group"
                      aria-label={t("workboard.cardActions")}
                      ref={workboardPopoverRef("end")}
                      onClick={closeWorkboardPopoverOnAction}
                    >
                      {!action().archived ? (
                        <CardAction
                          kind="edit"
                          workboard={props}
                          card={card()}
                          requestAction={requestTransition}
                        />
                      ) : undefined}
                      <CardAction
                        kind="archive"
                        workboard={props}
                        card={card()}
                        busy={action().busy}
                        archived={action().archived}
                        requestAction={requestTransition}
                      />
                      <CardAction
                        kind="delete"
                        workboard={props}
                        card={card()}
                        busy={action().busy}
                        requestAction={requestTransition}
                      />
                    </div>
                  </>
                ) : undefined}
                <button
                  class="btn btn--icon workboard-detail__icon workboard-detail__close"
                  type="button"
                  aria-label={t("common.close")}
                  onClick={dismissDetails}
                >
                  {icons.x}
                </button>
              </div>
            </header>
            <DetailTabs tabs={tabs()} activeTab={activeTab()} onSelect={selectTab} />
            <div class="workboard-detail__body" ref={workboardScrollFadeRef()}>
              <section
                class="workboard-detail__tabpanel"
                id="workboard-detail-panel-overview"
                role="tabpanel"
                aria-labelledby="workboard-detail-tab-overview"
                tabindex="0"
                hidden={activeTab() !== "overview"}
              >
                <div class="workboard-detail__layout">
                  <aside
                    class="workboard-detail__properties"
                    aria-label={t("workboard.detailProperties")}
                  >
                    <div class="workboard-detail__row">
                      <span>{t("workboard.fieldStatus")}</span>
                      {action().writable && !action().archived && state().statuses.length > 1 ? (
                        <InlineStatus workboard={props} card={card()} disabled={action().busy} />
                      ) : (
                        <strong>{formatStatusLabel(card().status)}</strong>
                      )}
                    </div>
                    <div class="workboard-detail__row">
                      <span>{t("workboard.fieldPriority")}</span>
                      {action().writable && !action().archived ? (
                        <InlinePriority workboard={props} card={card()} disabled={action().busy} />
                      ) : (
                        <strong
                          class={`workboard-detail__priority workboard-detail__priority--${card().priority}`}
                        >
                          {renderPriorityIcon(card().priority)}
                          {formatPriorityLabel(card().priority)}
                        </strong>
                      )}
                    </div>
                    <div class="workboard-detail__row">
                      <span>{t("workboard.fieldAgent")}</span>
                      {action().writable && !action().archived ? (
                        <InlineAgent workboard={props} card={card()} disabled={action().busy} />
                      ) : (
                        <strong class="workboard-detail__agent">
                          <AgentAvatar
                            {...{
                              agentId:
                                card().agentId?.trim() ||
                                props.agentsList?.defaultId ||
                                props.defaultAgentId ||
                                "",
                              label: cardAgentLabel(card(), props.agentsList),
                            }}
                          />
                          <span>{cardAgentLabel(card(), props.agentsList)}</span>
                        </strong>
                      )}
                    </div>
                    <DetailRow
                      label={t("workboard.detailUpdated")}
                      value={formatUpdatedTime(card().updatedAt)}
                    />
                    {state().boardFilter === WORKBOARD_ALL_BOARDS_FILTER ? (
                      <DetailRow
                        label={t("workboard.detailBoard")}
                        value={workboardBoardName(board() ?? { id: boardId() })}
                      />
                    ) : undefined}
                    <div class="workboard-detail__label-group">
                      <span>{t("workboard.fieldLabels")}</span>
                      <InlineText
                        owner={props}
                        card={card()}
                        field={"labels"}
                        disabled={action().busy}
                        readOnly={!action().writable || action().archived}
                      />
                    </div>
                  </aside>
                  <div class="workboard-detail__content">
                    <Show when={automation()?.summary || card().stage || card().pullRequestUrl}>
                      <section
                        class="workboard-detail__summary"
                        aria-label={t("workboard.detailSummary")}
                      >
                        <Show when={automation()?.summary}>
                          {(summary) => <Markdown markdown={summary()} />}
                        </Show>
                        <CardStage stage={card().stage} now={Date.now()} />{" "}
                        <CardPullRequest card={card()} />
                        <Show
                          when={
                            card().stage?.kind === "questions" &&
                            action().writable &&
                            !action().archived
                          }
                        >
                          <div class="workboard-detail__actions">
                            <button
                              class="btn"
                              type="button"
                              data-card-action="grill-questions"
                              title={t("workboard.grillQuestionsTitle")}
                              disabled={action().busy}
                              onClick={() =>
                                void grillWorkboardQuestions({
                                  ...workboardMutationContext(actionProps),
                                  cardId: card().id,
                                })
                              }
                            >
                              {t("workboard.grillQuestions")}
                            </button>
                          </div>
                        </Show>
                      </section>
                    </Show>
                    <InlineText
                      owner={props}
                      card={card()}
                      field={"notes"}
                      disabled={action().busy}
                      readOnly={!action().writable || action().archived}
                    />
                    <section
                      class={[
                        "workboard-detail__execution",
                        { "workboard-detail__execution--empty": sessionEmpty() },
                      ]}
                      aria-label={t("workboard.fieldSession")}
                    >
                      <CardSessionHeading
                        workboard={actionProps}
                        card={card()}
                        lifecycle={lifecycle()}
                        action={action()}
                        tab="overview"
                      />
                      {/* A restart continues the node ticket's own session; other starts would not. */}
                      {action().showStartControls && !canRestartWorkboardNodeTicket(card()) ? (
                        <details class="workboard-detail__disclosure workboard-detail__engine-options">
                          <summary>
                            <span class="workboard-detail__disclosure-chevron" aria-hidden="true">
                              {icons.chevronDown}
                            </span>
                            {t("workboard.detailExecutionOptions")}
                          </summary>
                          <div class="workboard-detail__engine-groups">
                            <For each={["autonomous", "manual"] as const} keyed={(mode) => mode}>
                              {(mode) => (
                                <Show
                                  when={mode() !== "autonomous" || props.canModelOverride !== false}
                                >
                                  <div class="workboard-detail__engine-group">
                                    <span>
                                      {t(
                                        mode() === "autonomous"
                                          ? "workboard.detailRunAutomatically"
                                          : "workboard.detailOpenManually",
                                      )}
                                    </span>
                                    <div class="workboard-detail__actions">
                                      <For
                                        each={["codex", "claude"] as const}
                                        keyed={(engine) => engine}
                                      >
                                        {(engine) => (
                                          <StartExecutionButton
                                            workboard={actionProps}
                                            card={card()}
                                            engine={engine()}
                                            mode={mode()}
                                          />
                                        )}
                                      </For>
                                    </div>
                                  </div>
                                </Show>
                              )}
                            </For>
                          </div>
                        </details>
                      ) : undefined}
                    </section>
                    <BoardAutomation
                      automation={props.detailBoardAutomation}
                      onNavigate={navigateAutomation}
                    />
                    {visibleAutomationFields().length ? (
                      <section class="workboard-detail__section workboard-detail__automation">
                        <h3>{t("workboard.detailCardAutomation")}</h3>
                        <For each={visibleAutomationFields()} keyed={(field) => field[0]}>
                          {(field) => <DetailRow label={field()[0]} value={field()[1]} />}
                        </For>
                      </section>
                    ) : undefined}
                    <DependencyDetailList dependencies={dependencies()} navigation={navigation} />
                  </div>
                </div>
              </section>
              <section
                class="workboard-detail__tabpanel workboard-detail__activity-panel"
                id="workboard-detail-panel-activity"
                role="tabpanel"
                aria-labelledby="workboard-detail-tab-activity"
                tabindex="0"
                hidden={activeTab() !== "activity"}
              >
                <NodeRounds rounds={card().rounds} />
                <section class="workboard-detail__section workboard-detail__activity">
                  {events().length ? (
                    <>
                      <h3>{t("workboard.eventsLabel")}</h3>
                      <ol class="workboard-detail__list workboard-detail__events">
                        <For each={events()} keyed={(event) => event.id}>
                          {(event) => (
                            <li>
                              <span>{formatEventLabel(event())}</span>
                              <time>{formatUpdatedTime(event().at)}</time>
                            </li>
                          )}
                        </For>
                      </ol>
                    </>
                  ) : undefined}
                  {comments().length ? (
                    <>
                      <h3>{t("workboard.detailOperatorNotes")}</h3>
                      <ol class="workboard-detail__list workboard-detail__comments">
                        <For each={comments()} keyed={(comment) => comment.id}>
                          {(comment) => (
                            <li>
                              <Markdown markdown={comment().body} />
                              <time>{formatUpdatedTime(comment().createdAt)}</time>
                            </li>
                          )}
                        </For>
                      </ol>
                    </>
                  ) : !events().length ? (
                    <p class="workboard-detail__empty">{t("workboard.detailNoNotes")}</p>
                  ) : undefined}
                  {action().writable ? (
                    <div class="workboard-detail__comment-compose">
                      <textarea
                        class="settings-input workboard-detail__note"
                        aria-label={t("workboard.detailOperatorNotes")}
                        rows="2"
                        maxlength="8000"
                        placeholder={t("workboard.detailNotePlaceholder")}
                        ref={noteValue}
                        disabled={action().busy}
                        onInput={(event) => {
                          state().detailCommentBody = event.currentTarget.value;
                          state().detailCommentDrafts.set(card().id, state().detailCommentBody);
                          props.onRequestUpdate?.();
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) {
                            return;
                          }
                          event.preventDefault();
                          if (!action().busy && state().detailCommentBody.trim()) {
                            void addWorkboardCardComment({
                              ...workboardMutationContext(props),
                              cardId: card().id,
                              body: state().detailCommentBody,
                            });
                          }
                        }}
                      />
                      <button
                        class="btn"
                        type="button"
                        disabled={action().busy || !state().detailCommentBody.trim()}
                        onClick={() => {
                          void addWorkboardCardComment({
                            ...workboardMutationContext(props),
                            cardId: card().id,
                            body: state().detailCommentBody,
                          });
                        }}
                      >
                        {t("workboard.detailAddNote")}
                      </button>
                    </div>
                  ) : undefined}
                </section>
              </section>
              <NodeTicketTabPanels workboard={props} card={card()} activeTab={activeTab()} />
              <TechnicalDetails
                data={technical()}
                active={state().detailTab === "details"}
                navigation={navigation}
              />
              <Show when={action().sessionTarget}>
                {(target) => (
                  <section
                    class="workboard-detail__tabpanel workboard-detail__session-panel"
                    id="workboard-detail-panel-session"
                    role="tabpanel"
                    aria-labelledby="workboard-detail-tab-session"
                    tabindex="0"
                    hidden={activeTab() !== "session"}
                  >
                    <CardSessionHeading
                      workboard={actionProps}
                      card={card()}
                      lifecycle={lifecycle()}
                      action={action()}
                      tab="session"
                    />
                    {activeTab() === "session" ? (
                      <SessionSummary
                        {...{
                          session: target(),
                          presented: props.presented !== false,
                        }}
                      />
                    ) : undefined}
                  </section>
                )}
              </Show>
            </div>
          </div>
        </aside>
        <WorkboardErrorToast owner={state()} error={visibleError()} />
      </>
    </Dialog>
  );
  return (
    <>
      {detailsDialog}
      {inlineDiscardOpen.has(state()) ? (
        <CardDiscardDialog
          {...{
            title: t("workboard.discardChangesTitle"),
            onKeepEditing: () => {
              inlineDiscardOpen.delete(state());
              props.onRequestUpdate?.();
            },
            onDiscard: () => {
              const transition = inlineDiscardOpen.get(state());
              inlineDiscardOpen.delete(state());
              for (const editor of inlineEditors()) {
                editor.discardDraft();
              }
              transition?.();
              props.onRequestUpdate?.();
            },
          }}
        />
      ) : undefined}
    </>
  );
}
