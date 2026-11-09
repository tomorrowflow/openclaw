/** @jsxImportSource @solidjs/web */
import { createMemo, createSignal, For } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { setWorkboardCardModel, type WorkboardCard } from "../../lib/workboard/index.ts";
import { workboardMutationContext, type WorkboardProps } from "./view-helpers.tsx";

type ModelChoice = { id: string; provider: string; name: string };
type CatalogState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; refs: string[] }
  | { status: "unavailable"; error: string };

/** The models this card's agent may run on the provider its node ticket already uses. */
export async function loadCardModelChoices(
  client: GatewayBrowserClient,
  params: { agentId?: string; provider: string },
): Promise<string[]> {
  const result = await client.request<{ models: ModelChoice[] }>("models.list", {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    provider: params.provider,
    preparedOnly: true,
  });
  return result.models
    .filter((model) => model.provider === params.provider)
    .map((model) => `${model.provider}/${model.id}`);
}

/**
 * A node ticket's model. Changing it writes the card target; the next start
 * runs the card's session on it. The catalog loads on first focus so opening
 * a card costs no catalog read.
 */
export function CardModelControl(props: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  busy: boolean;
  writable: boolean;
}) {
  const [catalog, setCatalog] = createSignal<CatalogState>({ status: "idle" });
  const current = () => props.card.metadata?.automation?.target?.model ?? "";
  const running = () => props.card.status === "running" || Boolean(props.card.metadata?.claim);
  const choices = createMemo(() => {
    const state = catalog();
    const listed = state.status === "loaded" ? state.refs : [];
    return current() && !listed.includes(current()) ? [current(), ...listed] : listed;
  });
  const hint = () => {
    const state = catalog();
    return running()
      ? t("workboard.detailModelRunning")
      : state.status === "unavailable"
        ? t("workboard.detailModelUnavailable", { error: state.error })
        : t("workboard.detailModelHelp");
  };
  const load = () => {
    const client = props.workboard.client;
    const provider = current().split("/")[0];
    if (!client || !provider || catalog().status !== "idle") {
      return;
    }
    setCatalog({ status: "loading" });
    loadCardModelChoices(client, { agentId: props.card.agentId, provider }).then(
      (refs) => setCatalog({ status: "loaded", refs }),
      (error: unknown) => setCatalog({ status: "unavailable", error: formatUiError(error) }),
    );
  };
  const change = (model: string) => {
    if (model && model !== current()) {
      void setWorkboardCardModel({
        ...workboardMutationContext(props.workboard),
        cardId: props.card.id,
        model,
      });
    }
  };
  return (
    <div class="workboard-detail__model">
      <label class="workboard-detail__model-field">
        <span>{t("workboard.detailModel")}</span>
        <select
          data-card-model
          value={current()}
          disabled={!props.writable || props.busy || running()}
          onFocus={load}
          onPointerDown={load}
          onChange={(event) => change(event.currentTarget.value)}
        >
          <For each={choices()} keyed={(ref) => ref}>
            {(ref) => <option value={ref()}>{ref()}</option>}
          </For>
        </select>
      </label>
      <p class="workboard-detail__model-hint" textContent={hint()} />
    </div>
  );
}
