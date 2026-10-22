import type { WorkboardNodeFileSource } from "@openclaw/workboard-contract";
import type { ControlUiPageTarget } from "openclaw/plugin-sdk/control-ui";

export const PROTOTYPE_PAGE_ID = "prototype";

/** One prototype file of one card, as the pop-out page's address names it. */
export type PrototypeTarget = { cardId: string; source: WorkboardNodeFileSource; path: string };

/** `source` is `live` or a round number, so the address survives copying to another device. */
export function prototypePageTarget(target: PrototypeTarget): ControlUiPageTarget {
  return {
    id: PROTOTYPE_PAGE_ID,
    params: {
      card: target.cardId,
      source: "live" in target.source ? "live" : String(target.source.round),
      path: target.path,
    },
  };
}

/** Undefined when the address lacks a card, a valid source, or a path. */
export function parsePrototypeTarget(
  params: Readonly<Record<string, string>>,
): PrototypeTarget | undefined {
  const { card, source, path } = params;
  if (!card || !path || !source || !/^(?:live|\d+)$/u.test(source)) {
    return undefined;
  }
  return {
    cardId: card,
    source: source === "live" ? { live: true } : { round: Number(source) },
    path,
  };
}
