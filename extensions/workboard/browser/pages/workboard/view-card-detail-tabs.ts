import { html } from "lit";
import { t } from "../../i18n/index.ts";
import type { WorkboardUiState } from "../../lib/workboard/index.ts";

type DetailTab = { id: WorkboardUiState["detailTab"]; label: string };

/** The card drawer's tab strip; arrow keys, Home, and End move between tabs. */
export function renderDetailTabs(
  tabs: readonly DetailTab[],
  activeTab: WorkboardUiState["detailTab"],
  selectTab: (tab: WorkboardUiState["detailTab"], target: EventTarget | null) => void,
) {
  return html`<div
    class="workboard-detail__tabs"
    role="tablist"
    aria-label=${t("workboard.detailTitle")}
    @keydown=${(event: KeyboardEvent) => {
      const index = tabs.findIndex((tab) => tab.id === activeTab);
      let next: number;
      if (event.key === "ArrowRight") {
        next = (index + 1) % tabs.length;
      } else if (event.key === "ArrowLeft") {
        next = (index + tabs.length - 1) % tabs.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = tabs.length - 1;
      } else {
        return;
      }
      const nextTab = tabs[next];
      if (!nextTab) {
        return;
      }
      event.preventDefault();
      selectTab(nextTab.id, event.currentTarget);
      if (event.currentTarget instanceof HTMLElement) {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]");
        buttons[next]?.focus();
      }
    }}
  >
    ${tabs.map(
      (tab) => html`<button
        type="button"
        role="tab"
        id=${`workboard-detail-tab-${tab.id}`}
        aria-controls=${`workboard-detail-panel-${tab.id}`}
        aria-selected=${String(activeTab === tab.id)}
        tabindex=${activeTab === tab.id ? "0" : "-1"}
        ?autofocus=${activeTab === tab.id}
        @click=${(event: MouseEvent) => selectTab(tab.id, event.currentTarget)}
      >
        ${tab.label}
      </button>`,
    )}
  </div>`;
}
