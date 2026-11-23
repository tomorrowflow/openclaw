/** @jsxImportSource @solidjs/web */
import type { WorkboardNodeFileLocation } from "@openclaw/workboard-contract";
import { createSignal, For, Show } from "solid-js";
import { workboardHost } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { nodeFilePageTarget, SCREENSHOT_PAGE_ID } from "../node-file/node-file-target.ts";
import type { SettledList } from "./card-node-files.ts";
import { flowScreenshotPath } from "./flow-links.ts";
import { type CardHtmlFiles, HtmlFilesPanel, type ShownHtmlFile } from "./view-card-html-files.tsx";

type Located = WorkboardNodeFileLocation & {
  source: NonNullable<WorkboardNodeFileLocation["source"]>;
};

/** Why the last link clicked in the report `key` did not open, with the address to click when a window was refused. */
type LinkNote = { key: string; text: string; href?: string };

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isLocated(shot: WorkboardNodeFileLocation | undefined): shot is Located {
  return shot?.source !== undefined;
}

function sourceLabel(shot: Located): string {
  if ("live" in shot.source) {
    return t("workboard.flowSourceLive");
  }
  if ("base" in shot.source) {
    return t("workboard.flowSourceBase");
  }
  return shot.cardId ? t("workboard.flowSourceLinked") : t("workboard.flowSourceRound");
}

/**
 * The drawer's Flows tab: a flow report with the screenshots it links to.
 * A link in the report opens its screenshot's pop-out page in a new window;
 * any other link is named in a note instead of followed.
 */
export function FlowsPanel(props: {
  files: CardHtmlFiles;
  cardId: string;
  listed: SettledList;
  active: boolean;
  revision?: number;
}) {
  const [note, setNote] = createSignal<LinkNote>();
  const popoutHref = (shot: Located) =>
    workboardHost().navigation.pageHref(
      nodeFilePageTarget(SCREENSHOT_PAGE_ID, {
        cardId: shot.cardId ?? props.cardId,
        source: shot.source,
        path: shot.path,
      }),
    );
  const openLink = (shown: ShownHtmlFile, href: string) => {
    const key = shown.ref.key;
    const path = flowScreenshotPath(shown.ref.path, href);
    if (!path) {
      setNote({ key, text: t("workboard.flowLinkIgnored", { href }) });
      return;
    }
    const shot = shown.screenshots?.find((entry) => entry.path === path);
    if (!isLocated(shot)) {
      setNote({ key, text: t("workboard.flowLinkMissing", { path }) });
      return;
    }
    const target = popoutHref(shot);
    // The click happened inside the preview frame, so a browser may refuse the window.
    setNote(
      window.open(target, "_blank")
        ? undefined
        : { key, text: t("workboard.flowLinkBlocked", { path }), href: target },
    );
  };
  return (
    <HtmlFilesPanel
      files={props.files}
      cardId={props.cardId}
      listed={props.listed}
      active={props.active}
      revision={props.revision}
      onLink={openLink}
      above={(shown) => {
        const shots = () =>
          (shown().screenshots ?? []).map((shot) =>
            isLocated(shot)
              ? { path: shot.path, href: popoutHref(shot), source: sourceLabel(shot) }
              : { path: shot.path },
          );
        const shownNote = () => (note()?.key === shown().ref.key ? note() : undefined);
        return (
          <>
            <Show when={shots().length > 0}>
              <ul class="workboard-flows__screenshots" aria-label={t("workboard.flowScreenshots")}>
                <For each={shots()} keyed={(shot) => shot.path}>
                  {(shot) => (
                    <li title={shot().path}>
                      <Show
                        when={shot().href}
                        fallback={
                          <span class="workboard-flows__missing">
                            {fileName(shot().path)} · {t("workboard.flowScreenshotMissing")}
                          </span>
                        }
                      >
                        {(href) => (
                          <>
                            <a href={href()} target="_blank" rel="noopener">
                              {fileName(shot().path)}
                            </a>
                            <span class="workboard-flows__source"> · {shot().source}</span>
                          </>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={shownNote()}>
              {(current) => (
                <p class="workboard-flows__note" role="status">
                  {current().text}{" "}
                  <Show when={current().href}>
                    {(href) => (
                      <a href={href()} target="_blank" rel="noopener">
                        {t("workboard.flowOpenScreenshot")}
                      </a>
                    )}
                  </Show>
                </p>
              )}
            </Show>
          </>
        );
      }}
    />
  );
}
