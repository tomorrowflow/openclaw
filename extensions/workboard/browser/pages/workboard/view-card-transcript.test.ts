import "../../test/dom.setup.ts";
import { expect, it, onTestFinished, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardProps } from "./view-helpers.tsx";
import { createWorkboardView, toast } from "./view.test-support.ts";

const portal = {
  id: "p17317",
  title: "Transcripts",
  port: 17317,
  listenPort: 35535,
  url: "https://gateway.example.ts.net:35535/?openclaw_portal=token",
  tokenQuery: "openclaw_portal=token",
  publicUrl: "https://gateway.example.ts.net:35535/",
  createdAtMs: 1,
};

function mountDetails(respond: () => Promise<unknown>) {
  const tab = { opener: window as Window | null, location: { href: "" }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  onTestFinished(() => open.mockRestore());
  const request = vi.fn(respond);
  const client = { request } as unknown as NonNullable<WorkboardProps["client"]>;
  const { state, container, renderView } = createWorkboardView({
    client,
    canWrite: true,
    transcriptViewerPort: 17317,
  });
  state.cards = [
    createWorkboardCard({ id: "card/1 #a", sessionKey: "agent:dev:subagent:ticket" }),
    createWorkboardCard({ id: "card-2", runId: "run-2", position: 2000 }),
  ];
  state.detailTab = "details";
  const show = (cardId: string, props: Partial<WorkboardProps> = {}) => {
    state.detailCardId = cardId;
    state.detailTab = "details";
    renderView(props);
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Open transcript",
    );
  };
  return { container, tab, open, request, show };
}

it("opens a card's transcript through a portal in the tab the click opened", async () => {
  const { tab, open, request, show } = mountDetails(async () => portal);

  show("card/1 #a")?.click();

  expect(open).toHaveBeenCalledWith("", "_blank");
  await vi.waitFor(() =>
    expect(tab.location.href).toBe(
      "https://gateway.example.ts.net:35535/card/card%2F1%20%23a?openclaw_portal=token",
    ),
  );
  expect(request.mock.calls).toEqual([["portal.open", { port: 17317, title: "Transcripts" }]]);
  expect(tab.opener).toBeNull();
  expect(tab.close).not.toHaveBeenCalled();
});

it.each([
  [
    "the request fails",
    () => Promise.reject(new Error("missing scope: operator.write")),
    "missing scope: operator.write",
  ],
  [
    "the portal has no token",
    async () => ({ ...portal, tokenQuery: undefined, url: undefined }),
    "did not return a usable portal",
  ],
])("closes the opened tab and shows an error when %s", async (_case, respond, message) => {
  const { container, tab, show } = mountDetails(respond);

  show("card/1 #a")?.click();

  await vi.waitFor(() => expect(tab.close).toHaveBeenCalledOnce());
  expect(tab.location.href).toBe("");
  await vi.waitFor(() =>
    expect(toast(container).querySelector('[role="alert"]')?.textContent).toContain(message),
  );
});

it("offers the transcript only for a writable card with a linked session and a configured port", () => {
  const { show } = mountDetails(async () => portal);

  expect(show("card/1 #a")).toBeDefined();
  expect(show("card/1 #a", { transcriptViewerPort: null })).toBeUndefined();
  expect(show("card/1 #a", { transcriptViewerPort: undefined })).toBeUndefined();
  expect(show("card/1 #a", { canWrite: false })).toBeUndefined();
  expect(show("card-2")).toBeUndefined();
});
