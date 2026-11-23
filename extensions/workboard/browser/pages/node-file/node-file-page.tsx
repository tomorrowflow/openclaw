/** @jsxImportSource @solidjs/web */
import type {
  WorkboardPrototypeResult,
  WorkboardScreenshotResult,
} from "@openclaw/workboard-contract";
import { type JSX, render } from "@solidjs/web";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Match, Switch } from "solid-js";
import { HtmlPreview } from "../../components/host-components.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { type NodeFileTarget, parseNodeFileTarget } from "./node-file-target.ts";

type PageState<Result> =
  | { status: "invalid" }
  | { status: "loading" }
  | { status: "loaded"; result: Result }
  | { status: "failed"; error: string };

type FilePage<Result> = {
  /** The Gateway method that reads the addressed file. */
  method: string;
  loading: () => string;
  invalid: () => string;
  failed: (error: string) => string;
  /** Stands in for the error when the Gateway's refusal carries no message. */
  noReason: () => string;
  view: (props: { result: Result; path: string }) => JSX.Element;
};

/** The Prototype tab's pop-out: one prototype filling the page. */
export function createPrototypePage(): ControlUiView {
  return createFilePage<WorkboardPrototypeResult>({
    method: "workboard.cards.prototypes.get",
    loading: () => t("workboard.prototypeLoading"),
    invalid: () => t("workboard.prototypeLinkInvalid"),
    failed: (error) => t("workboard.prototypeFailed", { error }),
    noReason: () => t("workboard.prototypeReadFailed"),
    view: (props) => (
      <HtmlPreview
        class="workboard-prototype-page__frame"
        html={props.result.html}
        title={props.path}
      />
    ),
  });
}

/** One screenshot at full size, opened from the Screenshots tab or a flow report's link. */
export function createScreenshotPage(): ControlUiView {
  return createFilePage<WorkboardScreenshotResult>({
    method: "workboard.cards.screenshots.get",
    loading: () => t("workboard.screenshotPageLoading"),
    invalid: () => t("workboard.screenshotLinkInvalid"),
    failed: (error) => t("workboard.screenshotPageFailed", { error }),
    noReason: () => t("workboard.screenshotReadFailed"),
    view: (props) => (
      <div class="workboard-screenshot-page__scroll">
        <img
          class="workboard-screenshot-page__image"
          src={`data:${props.result.mimeType};base64,${props.result.contentBase64}`}
          alt={props.path}
        />
      </div>
    ),
  });
}

/**
 * A pop-out page showing one file of one card. It reads the file again from
 * its address alone, so the link also opens on another device.
 */
function createFilePage<Result>(page: FilePage<Result>): ControlUiView {
  return (container, initialContext) => {
    const host = initialContext.host;
    let context = initialContext;
    // The serialized address being shown; "null" when it names no file.
    let key: string | undefined;
    let target: NodeFileTarget | null = null;
    // One read per address and connection; a reconnect retries a failed read.
    let requested = false;
    // Only the newest read may settle the page, even after a reconnect overlaps one.
    let attempt = 0;
    let disposed = false;
    // Plain state owns the page; the signal only tells the rendering to reread it.
    let current: PageState<Result> = { status: "loading" };
    const [state, setState] = createSignal<PageState<Result>>(current);
    const show = (next: PageState<Result>) => {
      current = next;
      setState(next);
    };
    const [path, setPath] = createSignal("");
    const failure = () => {
      const shown = state();
      return shown.status === "failed" ? shown.error : "";
    };
    const loaded = () => {
      const shown = state();
      return shown.status === "loaded" ? shown.result : undefined;
    };

    const load = () => {
      const next = parseNodeFileTarget(context.props) ?? null;
      const nextKey = JSON.stringify(next);
      if (nextKey !== key) {
        key = nextKey;
        target = next;
        requested = false;
        attempt++;
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
      const readAttempt = ++attempt;
      const { cardId, source, path: file } = target;
      show({ status: "loading" });
      void host
        .request<Result>(page.method, { id: cardId, path: file, ...source })
        .then(
          (result): PageState<Result> => ({ status: "loaded", result }),
          (error: unknown): PageState<Result> => ({
            status: "failed",
            error: formatUiError(error, page.noReason()),
          }),
        )
        .then((settled) => {
          if (!disposed && readAttempt === attempt) {
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
                {page.loading()}
              </p>
            }
          >
            <Match when={state().status === "invalid"}>
              <p class="workboard-prototype-page__message" role="alert">
                {page.invalid()}
              </p>
            </Match>
            <Match when={state().status === "failed"}>
              <p class="workboard-prototype-page__message" role="alert">
                {page.failed(failure())}
              </p>
            </Match>
            <Match when={loaded()}>
              {(result) => <page.view result={result()} path={path()} />}
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
