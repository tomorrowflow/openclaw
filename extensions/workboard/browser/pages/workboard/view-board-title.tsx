/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { WorkboardBoardGlyph } from "../../components/workboard-board-glyph.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { openPortalTab } from "../../lib/portal.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import type { WorkboardBoardSummary } from "../../lib/workboard/types.ts";
import { BoardInfo, boardHasInfo } from "./view-board-info.tsx";
import type { WorkboardProps } from "./view-helpers.tsx";

/** The page title: the board's glyph and name, plus its architecture-map, project-info, and edit buttons. */
export function BoardTitle(props: {
  board: WorkboardBoardSummary | null | undefined;
  /** The connection: write opens portals and edits, admin (the model-override scope) reveals secrets. */
  access: Pick<WorkboardProps, "canWrite" | "canModelOverride" | "client"> | undefined;
  architectureViewerPort: number | null;
  onEdit: (board: WorkboardBoardSummary) => void;
  onError: (message: string) => void;
}) {
  // Only project boards (with a node target) have a repository, and so a map. Opening a
  // portal needs operator.write.
  const architecture = () => {
    const { board, architectureViewerPort: port } = props;
    const client = props.access?.client;
    return port !== null && props.access?.canWrite && client && board?.orchestration?.defaultTarget
      ? { client, port, boardId: board.id }
      : undefined;
  };
  return (
    <div class="page-title workboard-page-title">
      <Show when={props.board}>
        {(board) => <WorkboardBoardGlyph board={board()} class="workboard-board-glyph--header" />}
      </Show>
      <span>
        {props.board
          ? workboardBoardName(props.board)
          : props.board === null
            ? t("workboard.allBoards")
            : "Workboard"}
      </span>
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
      <Show when={boardHasInfo(props.board) && props.board}>
        {(board) => (
          <BoardInfo
            board={board()}
            client={props.access?.client}
            canAdmin={Boolean(props.access?.canModelOverride)}
            onError={props.onError}
          />
        )}
      </Show>
      <Show when={props.access?.canWrite && props.board}>
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
