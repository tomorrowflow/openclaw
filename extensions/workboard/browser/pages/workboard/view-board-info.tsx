/** @jsxImportSource @solidjs/web */
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type {
  WorkboardBoardLink,
  WorkboardBoardSecret,
  WorkboardBoardSummary,
} from "../../lib/workboard/types.ts";
import { workboardPopoverRef } from "./view-popover.ts";

const REVEAL_VISIBLE_MS = 30_000;
const POPOVER_ID = "workboard-board-info";

/** Whether the board has anything for the info popover to list. */
export function boardHasInfo(board: WorkboardBoardSummary | null | undefined): boolean {
  const settings = board?.orchestration;
  return Boolean(
    settings?.links?.length ||
    settings?.secrets?.length ||
    Object.keys(settings?.env ?? {}).length ||
    Object.keys(settings?.previewEnv ?? {}).length,
  );
}

type InfoGroup = { heading: string; links: WorkboardBoardLink[]; secrets: WorkboardBoardSecret[] };

/** Links and secrets sharing a `group` render under one heading, in the order first listed. */
function groupInfo(board: WorkboardBoardSummary): InfoGroup[] {
  const groups = new Map<string, InfoGroup>();
  const groupFor = (name: string | undefined) => {
    const heading = name ?? t("workboard.boardInfoGeneral");
    let group = groups.get(heading);
    if (!group) {
      group = { heading, links: [], secrets: [] };
      groups.set(heading, group);
    }
    return group;
  };
  for (const link of board.orchestration?.links ?? []) {
    groupFor(link.group).links.push(link);
  }
  for (const secret of board.orchestration?.secrets ?? []) {
    groupFor(secret.group).secrets.push(secret);
  }
  return [...groups.values()];
}

/** One revealable secret: masked until an admin reveals it, hidden again after 30 seconds. */
function SecretRow(props: {
  boardId: string;
  secret: WorkboardBoardSecret;
  client: GatewayBrowserClient | null | undefined;
  canAdmin: boolean;
  onError: (message: string) => void;
}) {
  const [value, setValue] = createSignal<string | undefined>();
  const [copied, setCopied] = createSignal(false);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let revealing = false;
  const hide = () => {
    clearTimeout(hideTimer);
    setValue(undefined);
    setCopied(false);
  };
  // The row unmounts when the popover closes, which also drops the value.
  onSettled(() => () => clearTimeout(hideTimer));
  const reveal = async () => {
    if (!props.client || revealing) {
      return;
    }
    revealing = true;
    try {
      const result = await props.client.request<{ value: string }>(
        "workboard.boards.revealSecret",
        { boardId: props.boardId, name: props.secret.name },
      );
      setValue(result.value);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, REVEAL_VISIBLE_MS);
    } catch (error) {
      props.onError(formatUiError(error));
    } finally {
      revealing = false;
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value() ?? "");
      setCopied(true);
    } catch (error) {
      props.onError(formatUiError(error));
    }
  };
  return (
    <div class="workboard-board-info__row">
      <span class="workboard-board-info__label">{props.secret.label}</span>
      <code class="workboard-board-info__value" data-secret-name={props.secret.name}>
        {value() ?? "••••••••"}
      </code>
      <Show when={props.canAdmin}>
        <Show
          when={value() !== undefined}
          fallback={
            <button
              class="btn btn--icon"
              type="button"
              aria-label={t("workboard.boardInfoReveal", { label: props.secret.label })}
              title={t("workboard.boardInfoReveal", { label: props.secret.label })}
              onClick={() => void reveal()}
            >
              {icons.eye}
            </button>
          }
        >
          <button
            class="btn btn--icon"
            type="button"
            aria-label={t("workboard.boardInfoCopy", { label: props.secret.label })}
            title={t("workboard.boardInfoCopy", { label: props.secret.label })}
            onClick={() => void copy()}
          >
            {copied() ? icons.check : icons.copy}
          </button>
          <button
            class="btn btn--icon"
            type="button"
            aria-label={t("workboard.boardInfoHide", { label: props.secret.label })}
            title={t("workboard.boardInfoHide", { label: props.secret.label })}
            onClick={hide}
          >
            {icons.eyeOff}
          </button>
        </Show>
      </Show>
    </div>
  );
}

/** The board header's project-info button and its popover: links, env, and secrets. */
export function BoardInfo(props: {
  board: WorkboardBoardSummary;
  client: GatewayBrowserClient | null | undefined;
  canAdmin: boolean;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const groups = createMemo(() => groupInfo(props.board));
  const env = () => Object.entries(props.board.orchestration?.env ?? {});
  // A preview secret that is also revealable shows once, under its group.
  const previewSecrets = () => {
    const listed = new Set(props.board.orchestration?.secrets?.map((secret) => secret.name));
    return Object.entries(props.board.orchestration?.previewEnv ?? {}).filter(
      ([, id]) => !listed.has(id),
    );
  };
  return (
    <>
      <button
        class="btn btn--icon workboard-board-info-button"
        type="button"
        popovertarget={POPOVER_ID}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        aria-label={t("workboard.boardInfoOpen")}
        title={t("workboard.boardInfoOpen")}
      >
        {icons.link}
      </button>
      <div
        class="workboard-board-info"
        id={POPOVER_ID}
        popover="auto"
        role="dialog"
        aria-label={t("workboard.boardInfoOpen")}
        ref={workboardPopoverRef("start")}
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        <Show when={open()}>
          <For each={groups()}>
            {(group) => (
              <section class="workboard-board-info__section">
                <h3 class="workboard-board-info__heading">{group.heading}</h3>
                <For each={group.links}>
                  {(link) => (
                    <div class="workboard-board-info__row">
                      <a href={link.url} target="_blank" rel="noopener noreferrer">
                        {link.label}
                      </a>
                      <span class="workboard-board-info__url">{link.url}</span>
                    </div>
                  )}
                </For>
                <For each={group.secrets}>
                  {(secret) => (
                    <SecretRow
                      boardId={props.board.id}
                      secret={secret}
                      client={props.client}
                      canAdmin={props.canAdmin}
                      onError={props.onError}
                    />
                  )}
                </For>
              </section>
            )}
          </For>
          <Show when={env().length}>
            <section class="workboard-board-info__section">
              <h3 class="workboard-board-info__heading">{t("workboard.boardInfoEnv")}</h3>
              <For each={env()}>
                {([name, value]) => (
                  <div class="workboard-board-info__row">
                    <code class="workboard-board-info__label">{name}</code>
                    <code class="workboard-board-info__value">{value}</code>
                  </div>
                )}
              </For>
            </section>
          </Show>
          <Show when={previewSecrets().length}>
            <section class="workboard-board-info__section">
              <h3 class="workboard-board-info__heading">{t("workboard.boardInfoPreview")}</h3>
              <For each={previewSecrets()}>
                {([name, id]) => (
                  <div class="workboard-board-info__row">
                    <code class="workboard-board-info__label">{name}</code>
                    <Show when={id !== name}>
                      <span class="workboard-board-info__url">{id}</span>
                    </Show>
                  </div>
                )}
              </For>
            </section>
          </Show>
        </Show>
      </div>
    </>
  );
}
