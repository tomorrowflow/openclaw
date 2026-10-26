import type { ControlUiHost, ControlUiView } from "openclaw/plugin-sdk/control-ui";

export type ViewerPageSpec = {
  id: string;
  label: () => string;
  icon: string;
  order: number;
  /** Gateway method that returns `{ port }`, the viewer's loopback port or null when unset. */
  method: string;
  /** Omitted for a viewer opened from elsewhere (the board header), which needs only its port. */
  createPage?: (host: ControlUiHost, port: number) => ControlUiView;
};

/**
 * A page under Workboard that opens a viewer on a loopback port of the Gateway host. The
 * port is Gateway plugin config, so it can only change with a Gateway restart.
 */
export function createViewerPage(host: ControlUiHost, spec: ViewerPageSpec) {
  let port: number | null = null;
  let requested = false;
  let dispose: (() => void) | null = null;

  const register = (viewerPort: number, createPage: NonNullable<ViewerPageSpec["createPage"]>) => {
    const disposers = [
      host.ui.registerPage({
        id: spec.id,
        label: spec.label(),
        mount: createPage(host, viewerPort),
      }),
      host.ui.registerNavigation({
        id: spec.id,
        parent: "workboard",
        label: spec.label(),
        page: { id: spec.id },
        icon: spec.icon,
        order: spec.order,
      }),
    ];
    return () => {
      for (const disposer of disposers.toReversed()) {
        disposer();
      }
    };
  };

  // Opening a portal needs operator.write, so read-only operators get no page whose only control fails.
  const sync = () => {
    const createPage = spec.createPage;
    if (!createPage) {
      return;
    }
    const visiblePort = host.connection.canWrite ? port : null;
    if ((visiblePort === null) === (dispose === null)) {
      return;
    }
    dispose?.();
    dispose = visiblePort === null ? null : register(visiblePort, createPage);
    host.ui.invalidate();
  };

  const load = () => {
    if (requested || !host.connection.connected) {
      return;
    }
    requested = true;
    void host.request<{ port: number | null }>(spec.method, {}).then(
      (result) => {
        if (host.signal.aborted) {
          return;
        }
        port = typeof result.port === "number" ? result.port : null;
        if (spec.createPage) {
          sync();
        } else {
          host.ui.invalidate();
        }
      },
      // The next host change asks again.
      () => {
        requested = false;
      },
    );
  };

  return {
    port: () => port,
    load,
    sync,
    dispose: () => {
      dispose?.();
      dispose = null;
    },
  };
}
