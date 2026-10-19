import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";

type PortalAddress = { publicUrl: string; tokenQuery: string };

function readPortalAddress(value: unknown): PortalAddress | null {
  if (!isRecord(value)) {
    return null;
  }
  const { publicUrl, tokenQuery } = value;
  return typeof publicUrl === "string" && URL.canParse(publicUrl) && typeof tokenQuery === "string"
    ? { publicUrl, tokenQuery }
    : null;
}

/**
 * Opens `path` of the transcript viewer through an OpenClaw Portal to its loopback port.
 * Call it directly from a click handler: the tab opens before the first await so popup
 * blockers attribute it to the click. Rejects after closing that tab when the portal
 * cannot open.
 */
export async function openTranscriptViewer(
  client: GatewayBrowserClient,
  port: number,
  path: string,
): Promise<void> {
  const tab = window.open("", "_blank");
  if (!tab) {
    throw new Error(t("workboard.transcriptPopupBlocked"));
  }
  try {
    const portal = readPortalAddress(
      await client.request("portal.open", { port, title: t("workboard.transcriptsTitle") }),
    );
    if (!portal) {
      throw new Error(t("workboard.transcriptPortalUnavailable"));
    }
    tab.opener = null;
    tab.location.href = new URL(`${path}?${portal.tokenQuery}`, portal.publicUrl).href;
  } catch (error) {
    tab.close();
    throw error;
  }
}
