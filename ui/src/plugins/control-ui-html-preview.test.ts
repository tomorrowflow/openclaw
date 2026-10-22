/* @vitest-environment jsdom */

import { ContextProvider } from "@lit/context";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { applicationContext } from "../app/context.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

const html = "<!doctype html><button id=step>Step</button><script>step.onclick=()=>{}</script>";
const previewDocument: CanvasDocumentViewResult = {
  html,
  sandboxUrl: "/mcp-app-sandbox?frames=none",
  sandboxPort: 8444,
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
  document.body.replaceChildren();
});

function mountPreview(embedSandbox: "scripts" | "strict") {
  // The capability reads the embedded bootstrap config when the context is created.
  document.documentElement.setAttribute(
    CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
    JSON.stringify({ basePath: "", embedSandbox }),
  );
  const request = vi.fn(async (method: string) => {
    if (method === "canvas.document.preview") {
      return previewDocument;
    }
    throw new Error(`unexpected ${method}`);
  });
  const gateway = createGateway(createTestGatewayClient(request));
  const context = createContext(gateway, createSessions("main", []));
  const lifetime = new AbortController();
  const onError = vi.fn();
  // The application root provides the context to plugin containers in the shell.
  const shell = document.createElement("div");
  const provider = new ContextProvider(shell, {
    context: applicationContext,
    initialValue: context,
  });
  const container = document.createElement("div");
  shell.append(container);
  document.body.append(shell);
  onTestFinished(() => {
    lifetime.abort();
    provider.clearCallbacks();
  });
  const components = createControlUiComponents({
    current: () => context,
    signal: lifetime.signal,
    onError,
  });
  const handle = components.mountHtmlPreview(container, { html, title: "Checklist" });
  return { container, context, handle, request, onError };
}

async function postedDocument(container: HTMLElement) {
  await vi.dynamicImportSettled();
  await vi.waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  const frame = container.querySelector("iframe")!;
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: new URL(frame.src).origin,
      data: { method: "ui/notifications/sandbox-proxy-ready", params: { sandboxUrl: frame.src } },
    }),
  );
  await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
  return { frame, params: post.mock.calls[0]![0].params };
}

it("renders the document on the sandbox origin with scripts allowed", async () => {
  const { container, handle, request, onError } = mountPreview("scripts");

  const { frame, params } = await postedDocument(container);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "canvas.document.preview",
    { html },
    { timeoutMs: 30_000 },
  );
  expect(new URL(frame.src).port).toBe("8444");
  expect(frame.hasAttribute("srcdoc")).toBe(false);
  expect(frame.title).toBe("Checklist");
  expect(params).toEqual({ html, renderId: expect.any(String) });
  expect(container.querySelector("script, button")).toBeNull();

  handle.dispose();
  expect(container.childElementCount).toBe(0);
  expect(onError).not.toHaveBeenCalled();
});

it("keeps the operator's strict embed policy", async () => {
  const { container } = mountPreview("strict");

  const { params } = await postedDocument(container);
  expect(params).toMatchObject({ allowScripts: false });
});

it("applies an embed policy change to an open preview", async () => {
  const { container, context } = mountPreview("scripts");
  await postedDocument(container);

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ basePath: "", embedSandbox: "strict" })),
  );
  await context.config.refresh();
  await vi.waitFor(() =>
    expect(container.querySelector("openclaw-chat-html-preview")?.embedSandboxMode).toBe("strict"),
  );
  const { params } = await postedDocument(container);
  expect(params).toMatchObject({ allowScripts: false });
});
