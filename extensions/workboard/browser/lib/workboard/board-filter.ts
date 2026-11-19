import { isValidWorkboardBoardId } from "@openclaw/workboard-contract";
import type { WorkboardCard, WorkboardUiState } from "./types.ts";

export const WORKBOARD_ALL_BOARDS_FILTER = "__all__";

export function workboardCardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId?.trim() || "default";
}

export function matchesBoardFilter(
  card: WorkboardCard,
  filter: WorkboardUiState["boardFilter"],
): boolean {
  return filter === WORKBOARD_ALL_BOARDS_FILTER || workboardCardBoardId(card) === filter;
}

/**
 * The card list request scope for a board filter. The server pages cards per
 * board, so a board page never waits behind other boards' cards.
 */
export function workboardListScope(filter: WorkboardUiState["boardFilter"]): {
  boardId?: string;
} {
  return filter !== WORKBOARD_ALL_BOARDS_FILTER && isValidWorkboardBoardId(filter)
    ? { boardId: filter }
    : {};
}
