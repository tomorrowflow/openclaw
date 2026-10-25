/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiHost, ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createSignal } from "solid-js";
import { WorkboardErrorToast } from "../../components/toast.tsx";
import { t } from "../../i18n/index.ts";
import { openPortalTab } from "../../lib/portal.ts";
import { formatError } from "../../lib/workboard/normalization-utils.ts";

export function createTranscriptsPage(host: ControlUiHost, port: number): ControlUiView {
  return (container) => {
    const toastOwner = {};
    const [error, setError] = createSignal<string | null>(null);
    const open = () => {
      setError(null);
      openPortalTab(host, { port, title: t("workboard.transcriptsTitle"), path: "/" }).catch(
        (reason: unknown) => {
          setError(formatError(reason));
        },
      );
    };
    const dispose = render(
      () => (
        <>
          <section class="workboard-overview">
            <header class="workboard-overview__heading">
              <h1>{t("workboard.transcriptsTitle")}</h1>
            </header>
            <p>{t("workboard.transcriptsDescription")}</p>
            <p>
              <button type="button" class="btn" onClick={open}>
                {t("workboard.openTranscriptViewer")}
              </button>
            </p>
          </section>
          <WorkboardErrorToast owner={toastOwner} error={error()} />
        </>
      ),
      container,
    );
    return { dispose };
  };
}
