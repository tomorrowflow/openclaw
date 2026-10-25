/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.tsx";
import { WorkboardBoardGlyph } from "../../components/workboard-board-glyph.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { openPortalTab } from "../../lib/portal.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import type { WorkboardBoardSummary } from "../../lib/workboard/types.ts";

/** The page title: the board's glyph and name, plus its architecture-map and edit buttons. */
export function BoardTitle(props: {
  board: WorkboardBoardSummary | null | undefined;
  canWrite: boolean | undefined;
  client: GatewayBrowserClient | null | undefined;
  architectureViewerPort: number | null;
  onEdit: (board: WorkboardBoardSummary) => void;
  onError: (message: string) => void;
}) {
  // Only project boards (with a node target) have a repository, and so a map. Opening a
  // portal needs operator.write.
  const architecture = () => {
    const { board, client, architectureViewerPort: port } = props;
    return port !== null && props.canWrite && client && board?.orchestration?.defaultTarget
      ? { client, port, boardId: board.id }
      : undefined;
  };
  return (
    <div class="page-title workboard-page-title">
      <Show when={props.board}>
        {(board) => <WorkboardBoardGlyph board={board()} class="workboard-board-glyph--header" />}
      </Show>
      <span>{props.board ? workboardBoardName(props.board) : "Workboard"}</span>
      <Show when={architecture()}>
        {(target) => (
          <button
            class="btn btn--icon workboard-board-architecture"
            type="button"
            aria-label={t("workboard.openArchitectureMap")}
            title={t("workboard.openArchitectureMap")}
            onClick={() => {
              const { client, port, boardId } = target();
              openPortalTab(client, {
                port,
                title: t("workboard.architectureTitle"),
                path: `/board/${encodeURIComponent(boardId)}/`,
              }).catch((error: unknown) => props.onError(formatUiError(error)));
            }}
          >
            {icons.network}
          </button>
        )}
      </Show>
      <Show when={props.canWrite && props.board}>
        {(board) => (
          <button
            class="btn btn--icon workboard-board-edit"
            type="button"
            aria-label={t("workboard.editBoard")}
            title={t("workboard.editBoard")}
            onClick={() => props.onEdit(board())}
          >
            {icons.penLine}
          </button>
        )}
      </Show>
    </div>
  );
}
