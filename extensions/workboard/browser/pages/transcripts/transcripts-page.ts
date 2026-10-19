import { html, nothing, render } from "lit";
import type { ControlUiHost, ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { renderWorkboardErrorToast } from "../../components/toast.ts";
import { t } from "../../i18n/index.ts";
import { openTranscriptViewer } from "../../lib/transcript-viewer.ts";
import { formatError } from "../../lib/workboard/normalization-utils.ts";

export function createTranscriptsPage(host: ControlUiHost, port: number): ControlUiView {
  return (container) => {
    const toastOwner = {};
    let error: string | null = null;
    const update = () =>
      render(
        html`<section class="workboard-overview">
            <header class="workboard-overview__heading">
              <h1>${t("workboard.transcriptsTitle")}</h1>
            </header>
            <p>${t("workboard.transcriptsDescription")}</p>
            <p>
              <button type="button" class="btn" @click=${open}>
                ${t("workboard.openTranscriptViewer")}
              </button>
            </p>
          </section>
          ${renderWorkboardErrorToast(toastOwner, error)}`,
        container,
      );
    const open = () => {
      error = null;
      update();
      openTranscriptViewer(host, port, "/").catch((reason: unknown) => {
        error = formatError(reason);
        update();
      });
    };
    update();
    return { dispose: () => render(nothing, container) };
  };
}
