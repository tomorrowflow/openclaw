import type { WorkboardNodeFileSource } from "@openclaw/workboard-contract";
import type { ControlUiPageTarget } from "openclaw/plugin-sdk/control-ui";

export const PROTOTYPE_PAGE_ID = "prototype";
export const SCREENSHOT_PAGE_ID = "screenshot";

/** One file of one card, as a pop-out page's address names it. */
export type NodeFileTarget = { cardId: string; source: WorkboardNodeFileSource; path: string };

function sourceParam(source: WorkboardNodeFileSource): string {
  if ("round" in source) {
    return String(source.round);
  }
  return "live" in source ? "live" : "base";
}

/** `source` is `live`, `base`, or a round number, so the address survives copying to another device. */
export function nodeFilePageTarget(pageId: string, target: NodeFileTarget): ControlUiPageTarget {
  return {
    id: pageId,
    params: { card: target.cardId, source: sourceParam(target.source), path: target.path },
  };
}

/** Undefined when the address lacks a card, a valid source, or a path. */
export function parseNodeFileTarget(
  params: Readonly<Record<string, string>>,
): NodeFileTarget | undefined {
  const { card, source, path } = params;
  if (!card || !path || !source || !/^(?:live|base|\d+)$/u.test(source)) {
    return undefined;
  }
  return {
    cardId: card,
    source:
      source === "live"
        ? { live: true }
        : source === "base"
          ? { base: true }
          : { round: Number(source) },
    path,
  };
}
