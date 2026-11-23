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
import { openPortalTab } from "../../lib/portal.ts";
import {
  workboardCardBoardId,
  WORKBOARD_ALL_BOARDS_FILTER,
} from "../../lib/workboard/board-filter.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import { getWorkboardDependencyState } from "../../lib/workboard/card-state.ts";
import { isWorkboardNodeTicket } from "../../lib/workboard/execution.ts";
import { getWorkboardLifecycle } from "../../lib/workboard/lifecycle.ts";
import { grillWorkboardQuestions } from "../../lib/workboard/mutations.ts";
import { formatError } from "../../lib/workboard/normalization-utils.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import type { WorkboardCard, WorkboardUiState } from "../../lib/workboard/types.ts";
import { cardAgentLabel } from "./agent-filter.ts";
import { automationDetailFields, BoardAutomation } from "./view-automation.tsx";
import { getCardActionState, CardAction, StartExecutionButton } from "./view-card-actions.tsx";
import { hasCardChanges } from "./view-card-changes.tsx";
import { CardCommentCompose } from "./view-card-comment-compose.tsx";
import { CardPullRequest, CardStage } from "./view-card-content.tsx";
import {
  DependencyDetailList,
  DetailRow,
  TechnicalDetails,
  technicalDetailsData,
  type DetailNavigation,
} from "./view-card-detail-records.tsx";
import {
  DetailTabs,
  detailFlows,
  detailPrototypes,
  detailScreenshots,
  NodeTicketTabPanels,
} from "./view-card-detail-tabs.tsx";
import { CardDiscardDialog } from "./view-card-modal.tsx";
import { CardModelControl } from "./view-card-model.tsx";
import { NodeRounds } from "./view-card-rounds.tsx";
import { CardSessionHeading } from "./view-card-session-heading.tsx";
import {
  formatLifecycle,
  formatPriorityLabel,
  engineBlockedByRuntime,
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
import { closeWorkboardPopoverOnAction, workboardPopoverRef } from "./view-popover.ts";
import { workboardScrollFadeRef } from "./view-scroll-fade.ts";

export const workboardCardDetailDrawerId = "workboard-card-detail-drawer";
const workboardCardDetailTitleId = "workboard-card-detail-title";

const detailEditors = new WeakMap<WorkboardUiState, Set<WorkboardInlineText>>();
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
    const editors = detailEditors.get(state);
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
  const visibleError = () => workboardErrorMessage(state(), props.pageError);
  const card = () => {
    void props.revision;
    return props.card;
  };
  const editors = new Set<WorkboardInlineText>();
  let body: HTMLElement | undefined;
  const registerEditor = (editor: WorkboardInlineText) => {
    editors.add(editor);
    return () => editors.delete(editor);
  };
  const drawerOwner = createMemo(() => getWorkboardState(props.host));
  createEffect(drawerOwner, (detailState) => {
    detailEditors.set(detailState, editors);
    return () => {
      if (detailEditors.get(detailState) === editors) {
        detailEditors.delete(detailState);
        inlineDiscardOpen.delete(detailState);
      }
    };
  });
  const requestTransition = (transition: () => void) => {
    if ([...editors].some((editor) => editor.pendingSave)) {
      return false;
    }
    if ([...editors].some((editor) => editor.hasUnsavedChanges)) {
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
  const comments = createMemo(() => (card().metadata?.comments ?? []).toReversed());
  const automation = () => card().metadata?.automation;
  const boardId = () => workboardCardBoardId(card());
  const board = () => state().boards.find((entry) => entry.id === boardId());
  const dependencies = createMemo(() =>
    getWorkboardDependencyState(card(), state().cards, !state().nextCursor),
  );
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
    openSession: (sessionKey) => {
      const target = action().sessionTargetFor(sessionKey);
      return target ? () => actionProps.onOpenSession(target) : undefined;
    },
    get openTranscript() {
      const port = transcriptViewerPort();
      const client = props.client;
      const cardId = card().id;
      return port && client && action().linkedSessionKey
        ? () => {
            openPortalTab(client, {
              port,
              title: t("workboard.transcriptsTitle"),
              path: `/card/${encodeURIComponent(cardId)}`,
            }).catch((error: unknown) => {
              state().error = formatError(error);
              props.onRequestUpdate?.();
            });
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
      ...(detailPrototypes(props, card())
        ? [{ id: "prototype", label: t("workboard.detailTabPrototype") } as const]
        : []),
      ...(detailFlows(props, card())
        ? [{ id: "flows", label: t("workboard.detailTabFlows") } as const]
        : []),
      ...(card().preview
        ? [{ id: "preview", label: t("workboard.detailTabPreview") } as const]
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
          "--openclaw-modal-width: 620px; --openclaw-modal-backdrop-filter: none; --openclaw-modal-backdrop-color: rgba(0, 0, 0, 0.24);",
        onCancel: dismissDetails,
      }}
    >
      <>
        <aside id={workboardCardDetailDrawerId} class="workboard-detail-drawer">
          <div class="workboard-detail">
            <header class="workboard-detail__header">
              <div class="workboard-detail__heading">
                <h2 id={workboardCardDetailTitleId}>
                  <span class="sr-only">{t("workboard.detailTitle")}: </span>
                  <InlineText
                    owner={props}
                    card={card()}
                    field={"title"}
                    register={registerEditor}
                    disabled={action().busy}
                    readOnly={!action().writable || action().archived}
                  />
                </h2>
                <CardStage stage={card().stage} now={Date.now()} />
              </div>
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
            <div
              class="workboard-detail__body"
              ref={[
                workboardScrollFadeRef(),
                (element) => {
                  body = element;
                },
              ]}
            >
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
                          class={[
                            "workboard-detail__priority",
                            `workboard-detail__priority--${card().priority}`,
                          ]}
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
                        register={registerEditor}
                        disabled={action().busy}
                        readOnly={!action().writable || action().archived}
                      />
                    </div>
                  </aside>
                  <div class="workboard-detail__content">
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
                      {card().metadata?.automation?.target?.model && !action().archived ? (
                        <CardModelControl
                          workboard={actionProps}
                          card={card()}
                          busy={action().busy}
                          writable={action().writable}
                        />
                      ) : undefined}
                      {/* A node ticket runs on its node with the chosen model; an engine start would
                          bypass both. An agent pinned to another runtime refuses every engine start. */}
                      {action().showStartControls &&
                      !isWorkboardNodeTicket(card()) &&
                      !engineBlockedByRuntime(props, card(), "codex") ? (
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
                    <Show when={automation()?.summary || card().pullRequestUrl}>
                      <section
                        class="workboard-detail__summary"
                        aria-label={t("workboard.detailSummary")}
                      >
                        <Show when={automation()?.summary}>
                          {(summary) => <Markdown markdown={summary()} />}
                        </Show>
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
                    <DependencyDetailList dependencies={dependencies()} navigation={navigation} />
                    <InlineText
                      owner={props}
                      card={card()}
                      field={"notes"}
                      register={registerEditor}
                      disabled={action().busy}
                      readOnly={!action().writable || action().archived}
                    />
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
                {action().writable ? (
                  <CardCommentCompose
                    {...props}
                    card={card()}
                    busy={action().busy}
                    archived={action().archived}
                  />
                ) : undefined}
                <NodeRounds rounds={card().rounds} />
                <section class="workboard-detail__section workboard-detail__activity">
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
                  ) : (
                    <p class="workboard-detail__empty">{t("workboard.detailNoNotes")}</p>
                  )}
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
              for (const editor of editors) {
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
