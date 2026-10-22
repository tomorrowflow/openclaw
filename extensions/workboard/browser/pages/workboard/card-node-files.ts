import type { WorkboardNodeFileListResult } from "@openclaw/workboard-contract";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isWorkboardNodeTicket } from "../../lib/workboard/execution.ts";
import type { WorkboardCard } from "../../lib/workboard/index.ts";

type ListState =
  | { status: "loading" }
  // listedAt is this browser's receipt time, so "listed ago" never mixes clocks.
  | { status: "loaded"; result: WorkboardNodeFileListResult; listedAt: number }
  | { status: "unavailable"; error: string };

export type SettledList = Exclude<ListState, { status: "loading" }>;

/** One node ticket's files of one kind (screenshots, prototypes) as one Gateway connection lists them. */
export type CardFileList = {
  /** Lists the shown card; another card or none drops the rest through `onForget`. */
  show(card: WorkboardCard | undefined): void;
  /**
   * Lists the shown card again, keeping its last list meanwhile. False, and a
   * no-op, while nothing is shown or the current list is loading.
   */
  refresh(): boolean;
  /** Undefined for another card or while the first list is pending. */
  list(cardId: string): SettledList | undefined;
  dispose(): void;
};

/**
 * Node tickets only; a new round's import lists again. Without live files, a
 * card that has imported no round has nothing to list.
 */
function listKey(card: WorkboardCard, live: boolean): string | undefined {
  if (!isWorkboardNodeTicket(card)) {
    return undefined;
  }
  const key = (card.rounds ?? [])
    .flatMap((round) => (round.changes ? [round.changes.to] : []))
    .join(",");
  return key || live ? key : undefined;
}

/**
 * Created per connection, so a reconnect lists afresh. `onForget` drops what
 * the caller read for the previous card; `onListed` sees each accepted list
 * before it is published.
 */
export function createCardFileList(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
  options: {
    method: string;
    live: boolean;
    onForget?: () => void;
    onListed?: (result: WorkboardNodeFileListResult) => void;
  },
): CardFileList {
  let shown: { cardId: string; key: string; list: ListState; previous?: SettledList } | undefined;

  const relist = (cardId: string, key: string, previous: SettledList | undefined) => {
    const listing: NonNullable<typeof shown> = {
      cardId,
      key,
      list: { status: "loading" },
      ...(previous ? { previous } : {}),
    };
    shown = listing;
    void client
      .request<WorkboardNodeFileListResult>(options.method, { id: cardId, live: options.live })
      .then(
        (result): SettledList => ({ status: "loaded", result, listedAt: Date.now() }),
        (error: unknown): SettledList => ({ status: "unavailable", error: formatUiError(error) }),
      )
      .then((settled) => {
        if (shown === listing) {
          if (settled.status === "loaded") {
            options.onListed?.(settled.result);
          }
          listing.list = settled;
          delete listing.previous;
          requestUpdate();
        }
      });
  };

  const settledList = () =>
    shown && (shown.list.status === "loading" ? shown.previous : shown.list);

  return {
    show(card) {
      const key = card ? listKey(card, options.live) : undefined;
      if (!card || key === undefined) {
        shown = undefined;
        options.onForget?.();
        return;
      }
      if (shown?.cardId === card.id && shown.key === key) {
        return;
      }
      if (shown?.cardId !== card.id) {
        options.onForget?.();
        relist(card.id, key, undefined);
        return;
      }
      // A new import of the same card keeps its listed rounds until the new list arrives.
      relist(card.id, key, settledList());
    },
    refresh() {
      if (!shown || shown.list.status === "loading") {
        return false;
      }
      relist(shown.cardId, shown.key, settledList());
      return true;
    },
    list(cardId) {
      return shown?.cardId === cardId ? settledList() : undefined;
    },
    dispose() {
      shown = undefined;
      options.onForget?.();
    },
  };
}
