import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { WorkboardCatalog } from "./catalog.ts";
import { deleteWorkboardBoard } from "./delete-board.tsx";
import { bindWorkboardHost } from "./host.ts";
import { t } from "./i18n/index.ts";
import { workboardBoardName } from "./lib/workboard/board-presentation.ts";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { WORKBOARD_CHANGED_EVENT, type WorkboardBoardSummary } from "./lib/workboard/types.ts";
import { createOfficePage } from "./pages/office/office-page.tsx";
import { PROTOTYPE_PAGE_ID } from "./pages/prototype/prototype-target.ts";
import { createTranscriptsPage } from "./pages/transcripts/transcripts-page.tsx";
import { createLazyWorkboardPage } from "./pages/workboard/lazy-page.ts";
import { workboardPageTarget } from "./pages/workboard/page-target.ts";
import { createWorkboardSessionAccessory } from "./session-accessory.tsx";
import { createViewerPage } from "./viewer-page.ts";
import { createWorkboardWidget } from "./widgets.tsx";
import "./styles/workboard.css";
import "./styles/office.css";
import "./styles/overview.css";
import "./styles/widgets.css";
import "./styles/session-chip.css";

type NavigationBoard = Pick<WorkboardBoardSummary, "id" | "name" | "kind" | "icon" | "color">;

export default defineControlUiPlugin({
  id: "workboard",
  activate(host) {
    const unbind = bindWorkboardHost(host);
    const workboard = createWorkboardCapability();
    const client = host;
    let pendingDeletion: Promise<void> | undefined;
    const navigation = new Map<
      string,
      { board: NavigationBoard; order: number; signature: string; dispose: () => void }
    >();
    const syncBoardNavigation = (boards: readonly NavigationBoard[]) => {
      const nameCounts = new Map<string, number>();
      for (const board of boards) {
        const name = workboardBoardName(board);
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      const currentIds = new Set(boards.map((board) => board.id));
      for (const [id, entry] of navigation) {
        if (!currentIds.has(id)) {
          entry.dispose();
          navigation.delete(id);
        }
      }
      for (const [index, board] of boards.entries()) {
        const name = workboardBoardName(board);
        const label = (nameCounts.get(name) ?? 0) > 1 ? `${name} (${board.kind ?? "cards"})` : name;
        const order = 20 + index;
        const signature = JSON.stringify([label, board.icon, board.color, order]);
        const entry = navigation.get(board.id);
        if (entry?.signature === signature) {
          entry.board = board;
          continue;
        }
        entry?.dispose();
        navigation.set(board.id, {
          board,
          order,
          signature,
          dispose: host.ui.registerNavigation({
            id: `board-${board.id}`,
            parent: "workboard",
            label,
            page: workboardPageTarget(board.id),
            icon: board.icon ?? "kanban",
            order,
            defaultVisible: false,
            get actions() {
              const pinned = host.ui.isNavigationPinned(`board-${board.id}`);
              return [
                {
                  id: "pin",
                  label: t(pinned ? "workboard.unpinBoard" : "workboard.pinBoard"),
                  icon: pinned ? "pinOff" : "pin",
                  run: () => {
                    const id = `board-${board.id}`;
                    if (host.ui.isNavigationPinned(id)) {
                      host.ui.unpinNavigation(id);
                    } else {
                      host.ui.pinNavigation(id);
                    }
                  },
                },
                ...(host.connection.canWrite
                  ? [
                      {
                        id: "delete",
                        label: t("workboard.deleteBoard"),
                        icon: "trash",
                        destructive: true,
                        run: () =>
                          (pendingDeletion ??= deleteWorkboardBoard(host, board, () => {
                            host.ui.unpinNavigation(`board-${board.id}`);
                            catalog.removeBoard(board.id);
                          }).finally(() => {
                            pendingDeletion = undefined;
                          })),
                      },
                    ]
                  : []),
              ];
            },
          }),
        });
      }
    };
    const catalog = new WorkboardCatalog(({ boards }) => syncBoardNavigation(boards), workboard);
    const transcripts = createViewerPage(host, {
      id: "transcripts",
      label: () => t("workboard.transcriptsTitle"),
      icon: "scrollText",
      order: 12,
      method: "workboard.transcriptViewer",
      createPage: createTranscriptsPage,
    });
    const office = createViewerPage(host, {
      id: "office",
      label: () => t("workboard.officeTitle"),
      icon: "monitor",
      order: 13,
      method: "workboard.officeViewer",
      createPage: createOfficePage,
    });
    const viewers = [transcripts, office];
    const registrations = [
      host.ui.registerPage({
        id: "workboard",
        label: "Workboard",
        mount: createLazyWorkboardPage(async () => {
          const { createWorkboardPage } = await import("./pages/workboard/workboard-page.tsx");
          return createWorkboardPage(
            workboard,
            (board) => {
              const boards = [...navigation.values()]
                .toSorted((left, right) => left.order - right.order)
                .map((entry) => entry.board);
              const index = boards.findIndex((entry) => entry.id === board.id);
              boards[index < 0 ? boards.length : index] = board;
              syncBoardNavigation(boards);
              catalog.refresh();
            },
            transcripts.port,
          );
        }),
      }),
      host.ui.registerNavigation({
        id: "workboard",
        label: "Workboard",
        page: workboardPageTarget(),
        icon: "kanban",
        order: 10,
      }),
      host.ui.registerPage({
        id: "overview",
        label: t("workboard.overviewTitle"),
        mount: createLazyWorkboardPage(async () => {
          const { createOverviewPage } = await import("./pages/overview/overview-page.tsx");
          return createOverviewPage(workboard);
        }),
      }),
      host.ui.registerNavigation({
        id: "overview",
        parent: "workboard",
        label: t("workboard.overviewNav"),
        page: { id: "overview" },
        icon: "layoutDashboard",
        order: 11,
      }),
      // Opened only from the Prototype tab's link, so it has no navigation item.
      host.ui.registerPage({
        id: PROTOTYPE_PAGE_ID,
        label: t("workboard.detailTabPrototype"),
        mount: createLazyWorkboardPage(async () => {
          const { createPrototypePage } = await import("./pages/prototype/prototype-page.tsx");
          return createPrototypePage();
        }),
      }),
      host.ui.registerPanel({
        id: "screens",
        label: t("workboard.screens"),
        mount: createLazyWorkboardPage(async () => {
          const { createScreensPanel } = await import("./pages/screens/screens-panel.tsx");
          return createScreensPanel(workboard);
        }),
      }),
      host.ui.registerAccessory({
        id: "linked-card",
        placement: "session-header",
        mount: createWorkboardSessionAccessory(workboard),
      }),
      ...(["mini", "card", "board"] as const).map((id) =>
        host.ui.registerWidget({
          id,
          label:
            id === "mini"
              ? "Workboard summary"
              : id === "card"
                ? "Workboard card"
                : "Workboard board",
          mount: createWorkboardWidget(host, id),
        }),
      ),
      workboard.subscribe(host.ui.invalidate),
      host.subscribe(() => {
        catalog.sync(client, host.connection.connected);
        for (const viewer of viewers) {
          viewer.load();
          viewer.sync();
        }
      }),
      () => {
        for (const viewer of viewers) {
          viewer.dispose();
        }
      },
      host.onEvent(WORKBOARD_CHANGED_EVENT, (payload) =>
        catalog.handleGatewayEvent(WORKBOARD_CHANGED_EVENT, payload),
      ),
    ];
    catalog.sync(client, host.connection.connected);
    for (const viewer of viewers) {
      viewer.load();
    }
    return () => {
      for (const dispose of registrations.toReversed()) {
        dispose();
      }
      for (const { dispose } of navigation.values()) {
        dispose();
      }
      catalog.dispose();
      workboard.dispose();
      unbind();
    };
  },
});
