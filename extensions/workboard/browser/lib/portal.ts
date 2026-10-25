import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";

type PortalAddress = { publicUrl: string; tokenQuery: string };
export type PortalTarget = { port: number; title: string; path: string };

function readPortalAddress(value: unknown): PortalAddress | null {
  if (!isRecord(value)) {
    return null;
  }
  const { publicUrl, tokenQuery } = value;
  return typeof publicUrl === "string" && URL.canParse(publicUrl) && typeof tokenQuery === "string"
    ? { publicUrl, tokenQuery }
    : null;
}

/** Opens an OpenClaw Portal to a loopback port of the Gateway host and returns the URL of `path` through it. */
export async function openPortalUrl(
  client: GatewayBrowserClient,
  { port, title, path }: PortalTarget,
): Promise<string> {
  const portal = readPortalAddress(await client.request("portal.open", { port, title }));
  if (!portal) {
    throw new Error(t("workboard.portalUnavailable"));
  }
  return new URL(`${path}?${portal.tokenQuery}`, portal.publicUrl).href;
}

/**
 * Opens `target` in a new tab through a portal. Call it directly from a click handler: the
 * tab opens before the first await so popup blockers attribute it to the click. Rejects after
 * closing that tab when the portal cannot open.
 */
export async function openPortalTab(
  client: GatewayBrowserClient,
  target: PortalTarget,
): Promise<void> {
  const tab = window.open("", "_blank");
  if (!tab) {
    throw new Error(t("workboard.portalPopupBlocked"));
  }
  try {
    const href = await openPortalUrl(client, target);
    tab.opener = null;
    tab.location.href = href;
  } catch (error) {
    tab.close();
    throw error;
  }
}
