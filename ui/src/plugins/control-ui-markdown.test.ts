/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

it("renders sanitized Markdown through the host component handle", async () => {
  const gateway = createGateway(createTestGatewayClient(() => ({})));
  const context = createContext(gateway, createSessions("main", []));
  const lifetime = new AbortController();
  const onError = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    lifetime.abort();
    container.remove();
  });
  const components = createControlUiComponents({
    current: () => context,
    signal: lifetime.signal,
    onError,
  });

  const handle = components.mountMarkdown(container, {
    markdown:
      "## Plan\n\n- **ship** it\n- [docs](https://example.com)\n\n<img src=x onerror=alert(1)>",
  });
  await vi.dynamicImportSettled();
  await vi.waitFor(() => expect(container.querySelector(".sidebar-markdown h2")).not.toBeNull());
  expect(container.querySelector("li strong")?.textContent).toBe("ship");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  expect(container.querySelector("img, [onerror]")).toBeNull();

  handle.update({ markdown: "`code`" });
  await vi.waitFor(() => expect(container.querySelector("code")?.textContent).toBe("code"));
  expect(container.querySelector("h2")).toBeNull();

  handle.dispose();
  expect(container.childElementCount).toBe(0);
  expect(onError).not.toHaveBeenCalled();
});
