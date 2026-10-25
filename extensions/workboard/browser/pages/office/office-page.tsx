/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiHost, ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Show } from "solid-js";
import { WorkboardErrorToast } from "../../components/toast.tsx";
import { t } from "../../i18n/index.ts";
import { openPortalTab, openPortalUrl } from "../../lib/portal.ts";
import { formatError } from "../../lib/workboard/normalization-utils.ts";

const FRAME_SANDBOX =
  "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts";

export function createOfficePage(host: ControlUiHost, port: number): ControlUiView {
  return (container) => {
    const toastOwner = {};
    const [error, setError] = createSignal<string | null>(null);
    const target = { port, title: t("workboard.officeTitle"), path: "/" };
    const [frameUrl, setFrameUrl] = createSignal<string | null>(null);
    openPortalUrl(host, target).then(setFrameUrl, (reason: unknown) => {
      setError(formatError(reason));
    });
    const openInNewTab = () => {
      setError(null);
      openPortalTab(host, target).catch((reason: unknown) => {
        setError(formatError(reason));
      });
    };
    const dispose = render(
      () => (
        <>
          <section class="workboard-office">
            <header class="workboard-office__heading">
              <h1>{t("workboard.officeTitle")}</h1>
              <button type="button" class="btn" onClick={openInNewTab}>
                {t("workboard.openOfficeViewer")}
              </button>
            </header>
            <Show when={frameUrl()}>
              {(url) => (
                <iframe
                  class="workboard-office__frame"
                  src={url()}
                  title={t("workboard.officeFrameTitle")}
                  referrerpolicy="no-referrer"
                  sandbox={FRAME_SANDBOX}
                />
              )}
            </Show>
          </section>
          <WorkboardErrorToast owner={toastOwner} error={error()} />
        </>
      ),
      container,
    );
    return { dispose };
  };
}
