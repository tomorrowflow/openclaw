/** @jsxImportSource @solidjs/web */
import { For, Show } from "solid-js";
import { t } from "../../i18n/index.ts";
import {
  getWorkboardState,
  recordWorkboardVisualCheck,
  type WorkboardCard,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";
import { ChangesPanel, hasCardChanges } from "./view-card-changes.tsx";
import { GrillingPanel } from "./view-card-grilling.tsx";
import { hasPrototypes, PrototypePanel } from "./view-card-prototypes.tsx";
import { hasCommittedScreenshots, ScreenshotsPanel } from "./view-card-screenshots.tsx";
import { canMutate, type WorkboardProps, workboardMutationContext } from "./view-helpers.tsx";

type DetailTabId = WorkboardUiState["detailTab"];

/** The card drawer's tab strip; arrow keys, Home, and End move between tabs. */
export function DetailTabs(props: {
  tabs: readonly { id: DetailTabId; label: string }[];
  activeTab: DetailTabId;
  onSelect: (tab: DetailTabId, target: EventTarget | null) => void;
}) {
  return (
    <div
      class="workboard-detail__tabs"
      role="tablist"
      aria-label={t("workboard.detailTitle")}
      onKeyDown={(event) => {
        const index = props.tabs.findIndex((tab) => tab.id === props.activeTab);
        let next: number;
        if (event.key === "ArrowRight") {
          next = (index + 1) % props.tabs.length;
        } else if (event.key === "ArrowLeft") {
          next = (index + props.tabs.length - 1) % props.tabs.length;
        } else if (event.key === "Home") {
          next = 0;
        } else if (event.key === "End") {
          next = props.tabs.length - 1;
        } else {
          return;
        }
        const nextTab = props.tabs[next];
        if (!nextTab) {
          return;
        }
        event.preventDefault();
        props.onSelect(nextTab.id, event.currentTarget);
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]");
        buttons[next]?.focus();
      }}
    >
      <For each={props.tabs} keyed={(tab) => tab.id}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            id={`workboard-detail-tab-${tab().id}`}
            aria-controls={`workboard-detail-panel-${tab().id}`}
            aria-selected={props.activeTab === tab().id ? "true" : "false"}
            tabindex={props.activeTab === tab().id ? "0" : "-1"}
            autofocus={props.activeTab === tab().id}
            onClick={(event: MouseEvent) => props.onSelect(tab().id, event.currentTarget)}
          >
            {tab().label}
          </button>
        )}
      </For>
    </div>
  );
}

/** The card's committed screenshots, once listed and only when a round committed some. */
export function detailScreenshots(props: WorkboardProps, card: WorkboardCard) {
  void props.revision;
  const controller = props.detailScreenshots;
  const listed = controller?.list(card.id);
  return controller && listed && hasCommittedScreenshots(listed)
    ? { controller, listed }
    : undefined;
}

/** The Screenshots tab's visual check, once the imported round's verification finished. */
function visualCheckControl(props: WorkboardProps, card: WorkboardCard) {
  void props.revision;
  const visual = card.visualCheck;
  return visual
    ? {
        check: visual.check,
        busy: !canMutate(props) || getWorkboardState(props.host).busyCardIds.has(card.id),
        onRecord: (verdict: "looks_right" | "problem", note: string) =>
          void recordWorkboardVisualCheck({
            ...workboardMutationContext(props),
            cardId: card.id,
            verdict,
            note,
          }),
      }
    : undefined;
}

/** The card's prototypes, live and committed, once listed and only when there is one. */
export function detailPrototypes(props: WorkboardProps, card: WorkboardCard) {
  void props.revision;
  const controller = props.detailPrototypes;
  const listed = controller?.list(card.id);
  return controller && listed && hasPrototypes(listed) ? { controller, listed } : undefined;
}

/** A node ticket's Grilling, Changes, Screenshots, and Prototype tab panels, each only when it has content. */
export function NodeTicketTabPanels(props: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  activeTab: DetailTabId;
}) {
  return (
    <>
      <Show
        when={
          props.workboard.detailGrilling && props.card.grill
            ? props.workboard.detailGrilling
            : undefined
        }
      >
        {(grilling) => (
          <GrillingPanel
            workboard={props.workboard}
            grilling={grilling()}
            card={props.card}
            active={props.activeTab === "grilling"}
            revision={props.workboard.revision}
          />
        )}
      </Show>
      <Show
        when={
          props.workboard.detailChanges && hasCardChanges(props.card)
            ? props.workboard.detailChanges
            : undefined
        }
      >
        {(changes) => (
          <ChangesPanel
            changes={changes()}
            card={props.card}
            active={props.activeTab === "changes"}
            revision={props.workboard.revision}
          />
        )}
      </Show>
      <Show when={detailScreenshots(props.workboard, props.card)}>
        {(shown) => (
          <ScreenshotsPanel
            screenshots={shown().controller}
            cardId={props.card.id}
            listed={shown().listed}
            active={props.activeTab === "screenshots"}
            revision={props.workboard.revision}
            visualCheck={visualCheckControl(props.workboard, props.card)}
          />
        )}
      </Show>
      <Show when={detailPrototypes(props.workboard, props.card)}>
        {(shown) => (
          <PrototypePanel
            prototypes={shown().controller}
            cardId={props.card.id}
            listed={shown().listed}
            active={props.activeTab === "prototype"}
            revision={props.workboard.revision}
          />
        )}
      </Show>
    </>
  );
}
