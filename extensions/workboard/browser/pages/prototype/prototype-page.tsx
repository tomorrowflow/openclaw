import type { WorkboardPrototypeResult } from "@openclaw/workboard-contract";
/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Match, Switch } from "solid-js";
import { HtmlPreview } from "../../components/host-components.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { parsePrototypeTarget, type PrototypeTarget } from "./prototype-target.ts";

type PageState =
  | { status: "invalid" }
  | { status: "loading" }
  | { status: "loaded"; html: string }
  | { status: "failed"; error: string };

/**
 * The Prototype tab's pop-out: one prototype filling the page. It reads the
 * file again from its address alone, so the link also opens on another device.
 */
export function createPrototypePage(): ControlUiView {
  return (container, initialContext) => {
    const host = initialContext.host;
    let context = initialContext;
    // The serialized address being shown; "null" when it names no prototype.
    let key: string | undefined;
    let target: PrototypeTarget | null = null;
    // One read per address and connection; a reconnect retries a failed read.
    let requested = false;
    let disposed = false;
    // Plain state owns the page; the signal only tells the rendering to reread it.
    let current: PageState = { status: "loading" };
    const [state, setState] = createSignal<PageState>(current);
    const show = (next: PageState) => {
      current = next;
      setState(next);
    };
    const [path, setPath] = createSignal("");
    const failure = () => {
      const shown = state();
      return shown.status === "failed" ? shown.error : undefined;
    };
    const html = () => {
      const shown = state();
      return shown.status === "loaded" ? shown.html : "";
    };

    const load = () => {
      const next = parsePrototypeTarget(context.props) ?? null;
      const nextKey = JSON.stringify(next);
      if (nextKey !== key) {
        key = nextKey;
        target = next;
        requested = false;
        setPath(next?.path ?? "");
        show(next ? { status: "loading" } : { status: "invalid" });
      }
      if (!host.connection.connected) {
        requested = false;
        return;
      }
      if (!target || requested || current.status === "loaded") {
        return;
      }
      requested = true;
      const readKey = key;
      const { cardId, source, path: file } = target;
      show({ status: "loading" });
      void host
        .request<WorkboardPrototypeResult>("workboard.cards.prototypes.get", {
          id: cardId,
          path: file,
          ...source,
        })
        .then(
          (result): PageState => ({ status: "loaded", html: result.html }),
          (error: unknown): PageState => ({ status: "failed", error: formatUiError(error) }),
        )
        .then((settled) => {
          if (!disposed && readKey === key) {
            show(settled);
          }
        });
    };

    const disposeRoot = render(
      () => (
        <section class="workboard-prototype-page">
          <Switch
            fallback={
              <p class="workboard-prototype-page__message" role="status">
                {t("workboard.screenshotLoading")}
              </p>
            }
          >
            <Match when={state().status === "invalid"}>
              <p class="workboard-prototype-page__message" role="alert">
                {t("workboard.prototypeLinkInvalid")}
              </p>
            </Match>
            <Match when={failure()}>
              {(error) => (
                <p class="workboard-prototype-page__message" role="alert">
                  {t("workboard.prototypeFailed", { error: error() })}
                </p>
              )}
            </Match>
            <Match when={state().status === "loaded"}>
              <HtmlPreview class="workboard-prototype-page__frame" html={html()} title={path()} />
            </Match>
          </Switch>
        </section>
      ),
      container,
    );
    const stopHost = host.subscribe(load);
    load();
    return {
      update(next) {
        context = next;
        load();
      },
      dispose() {
        disposed = true;
        stopHost();
        disposeRoot();
      },
    };
  };
}
