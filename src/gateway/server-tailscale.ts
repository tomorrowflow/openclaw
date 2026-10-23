import { resolveSandboxHostPort } from "../agents/sandbox-host.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { TailscaleServeDisabledError } from "../infra/tailscale-serve-disabled-error.js";
import {
  claimTailscaleRoute,
  claimTailscaleServePort,
  getTailnetHostname,
  getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort,
} from "../infra/tailscale.js";
import { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
import type { GatewayTailscaleIngressEndpoint } from "./ingress-attribution.js";
import { prepareTailscalePublishedOrigin } from "./tailscale-published-origin.js";

/**
 * The sandbox port the managed Serve route should cover, if any. A configured
 * sandbox origin is the operator's route, a TLS sandbox listener needs a TLS
 * backend this claim does not build, and update validation never starts the
 * sandbox host.
 */
export function resolveManagedSandboxServePort(params: {
  gatewayPort: number;
  apps?: { sandboxOrigin?: string; sandboxPort?: number };
  gatewayTls: boolean;
  updateCanary: boolean;
}): number | undefined {
  if (params.apps?.sandboxOrigin || params.gatewayTls || params.updateCanary) {
    return undefined;
  }
  try {
    return resolveSandboxHostPort(params.gatewayPort, params.apps?.sandboxPort);
  } catch {
    // The sandbox host reports the invalid port when it starts.
    return undefined;
  }
}

export async function startGatewayTailscaleExposure(params: {
  tailscaleMode: "off" | "serve" | "funnel";
  port: number;
  backend?: GatewayTailscaleIngressEndpoint;
  preserveFunnel?: boolean;
  controlUiBasePath?: string;
  /** Sandbox host port to serve on the same tailnet host; omitted when another origin serves it. */
  sandboxPort?: number;
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void };
  signal?: AbortSignal;
}): Promise<(() => Promise<void>) | null> {
  if (params.tailscaleMode === "off") {
    return null;
  }
  if (!params.backend) {
    throw new Error("Managed Tailscale ingress failed to start");
  }
  const backendTarget = params.backend.port;
  const effectiveMode = params.tailscaleMode;
  let clearPublishedOrigin: (() => void) | undefined;
  if (params.tailscaleMode === "serve" && params.preserveFunnel === true) {
    let preservedFunnel: boolean;
    try {
      preservedFunnel = await hasTailscaleFunnelRouteForPort(params.port);
    } catch (error) {
      params.logTailscale.warn(
        `serve not changed because external Funnel status could not be inspected: ${formatErrorMessage(error)}`,
      );
      throw error;
    }
    if (preservedFunnel) {
      params.logTailscale.warn(
        `external Tailscale Funnel for port ${params.port} remains active only for plugin-authenticated webhook routes; Gateway-authenticated routes reject its unattributable ingress. ` +
          "First configure a durable gateway password (gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD) and set gateway.auth.mode=password, " +
          "then run `openclaw config set gateway.tailscale.mode funnel` and `openclaw config unset gateway.tailscale.preserveFunnel`; " +
          "see https://docs.openclaw.ai/gateway/tailscale#public-internet-funnel-%2B-shared-password",
      );
      return null;
    }
  }

  let claim: Awaited<ReturnType<typeof claimTailscaleRoute>> | undefined;
  try {
    claim = await claimTailscaleRoute(
      params.tailscaleMode,
      backendTarget,
      params.port,
      params.logTailscale.info,
      params.signal,
    );
    const hostname = (
      params.tailscaleMode === "serve" ? getTailnetHostnameAfterServe() : getTailnetHostname()
    ).catch((error: unknown) => {
      params.logTailscale.warn(
        `Could not read the Tailscale hostname; managed portal ingress is unavailable: ${formatErrorMessage(error)}`,
      );
      return null;
    });
    const host = await racePromiseWithAbortSignal(
      hostname,
      params.signal,
      (signal) => signal.reason,
    );
    params.signal?.throwIfAborted();
    if (!claim.isActive()) {
      throw new Error(`Managed Tailscale ${params.tailscaleMode} claim exited during startup`);
    }
    if (host) {
      const uiPath = params.controlUiBasePath ? `${params.controlUiBasePath}/` : "/";
      const publicHost = resolveTailscalePublishedHost({
        tailscaleMode: effectiveMode,
        tailnetHost: host,
      });
      if (publicHost) {
        clearPublishedOrigin = prepareTailscalePublishedOrigin({
          origin: `https://${publicHost}`,
          mode: effectiveMode,
        });
        params.logTailscale.info(
          `${params.tailscaleMode} enabled: https://${publicHost}${uiPath} (WS via wss://${publicHost})`,
        );
      } else {
        params.logTailscale.info(`${params.tailscaleMode} enabled`);
      }
    } else {
      params.logTailscale.info(`${params.tailscaleMode} enabled`);
    }
  } catch (err) {
    clearPublishedOrigin?.();
    try {
      await claim?.stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [err, cleanupError],
        "Tailscale exposure startup and cleanup failed",
        { cause: cleanupError },
      );
    }
    params.signal?.throwIfAborted();
    if (params.tailscaleMode === "serve" && err instanceof TailscaleServeDisabledError) {
      params.logTailscale.warn(
        "Tailscale Serve is not enabled on this tailnet. The authenticated local Gateway remains available on loopback; remote access is unavailable. Restore the intended tailnet Serve policy and restart the Gateway.",
      );
      return null;
    }
    params.logTailscale.warn(`${params.tailscaleMode} failed: ${formatErrorMessage(err)}`);
    throw err;
  }

  const sandboxClaim =
    params.sandboxPort === undefined
      ? undefined
      : await claimSandboxServeRoute(params.sandboxPort, params.logTailscale, params.signal);

  let stopping = false;
  void claim.exited.then(() => {
    if (stopping) {
      return;
    }
    clearPublishedOrigin?.();
    params.logTailscale.warn(
      `${params.tailscaleMode} route claim exited; managed Tailscale ingress is unavailable until the Gateway restarts`,
    );
  });
  void sandboxClaim?.exited.then(() => {
    if (!stopping) {
      params.logTailscale.warn(
        "sandbox route claim exited; HTML previews and MCP Apps are unavailable to remote browsers until the Gateway restarts",
      );
    }
  });
  return async () => {
    stopping = true;
    clearPublishedOrigin?.();
    await Promise.all([claim.stop(), sandboxClaim?.stop()]);
  };
}

// The Control UI frames HTML previews and MCP Apps from the Gateway host on the
// sandbox port, so a remote browser needs that port routed too. Serve only, like
// portals, and never fatal: a missing route degrades previews, not the Gateway.
async function claimSandboxServeRoute(
  port: number,
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void },
  signal?: AbortSignal,
) {
  try {
    const claim = await claimTailscaleServePort(port, port, () => signal?.throwIfAborted());
    logTailscale.info(`sandbox host served on tailnet HTTPS port ${port}`);
    return claim;
  } catch (error) {
    if (!signal?.aborted) {
      logTailscale.warn(
        `sandbox host not served on tailnet HTTPS port ${port}; remote browsers cannot load HTML previews or MCP Apps. Free the port or set mcp.apps.sandboxOrigin: ${formatErrorMessage(error)}`,
      );
    }
    return undefined;
  }
}
