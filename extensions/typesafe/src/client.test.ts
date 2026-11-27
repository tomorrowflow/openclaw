import type { DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimeConfig } from "./config.js";
import {
  mixedFixture,
  mockJsonResponse,
  registeredPreparedDecisionProvider,
} from "./transport.test-support.js";

// mock-isolation: the hosted plugin key comes from a fixture, not host secret state.
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));

const { batch, input, response, result } = mixedFixture;
const localUrl = "http://127.0.0.1:8009";
const kev = (value: object) => ({ ...value, model: "kev-latest" });

function registered(config: OpenClawConfig) {
  return registeredPreparedDecisionProvider(() => config);
}
const plugin = (config: Record<string, unknown> = {}) =>
  registered({ plugins: { entries: { typesafe: { config } } } });
const context = (model = input.model, apiKey = "synthetic-key"): DecisionProviderContextV2 => ({
  model: { provider: "typesafe", id: model, name: model },
  config: {},
  auth: { mode: "api-key", apiKey },
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 2000,
  isAdmissible: () => true,
});
function sent(fetch: ReturnType<typeof mockJsonResponse>) {
  const [url, init] = fetch.mock.calls[0]!;
  if (typeof init?.body !== "string") {
    throw new Error("Expected a serialized TypeSafe request");
  }
  return { url, headers: new Headers(init.headers), body: JSON.parse(init.body) };
}

beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: "synthetic-key" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("sends hosted Jev evaluations with the prepared bearer", async () => {
  const fetch = mockJsonResponse({ ...response, metrics: { latency: 3 } });
  await expect(plugin().evaluate(batch, context())).resolves.toEqual(result);
  const { url, headers, body } = sent(fetch);
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(headers.get("authorization")).toBe("Bearer synthetic-key");
  expect(body).toEqual(input);
});

it("encodes local Kev requests, strips latency and never sends a hosted key", async () => {
  const fetch = mockJsonResponse(kev(mixedFixture.localResponse));
  await expect(
    plugin({ baseUrl: localUrl }).evaluate(batch, context("kev-latest", "hosted-secret")),
  ).resolves.toEqual({ ...result, result: kev(result.result) });
  const { url, headers, body } = sent(fetch);
  expect(url).toBe(`${localUrl}/v1/systemone`);
  expect(headers.has("authorization")).toBe(false);
  expect(body).toEqual(kev(mixedFixture.localInput));
});

it.each([-1, "15"])("rejects invalid local latency metadata %s", async (latency_ms) => {
  mockJsonResponse(kev({ ...mixedFixture.localResponse, latency_ms }));
  await expect(
    plugin({ baseUrl: localUrl }).evaluate(batch, context("kev-latest", "typesafe-local")),
  ).resolves.toEqual({ status: "unavailable", reason: "invalid-response" });
});

it("refuses hosted dispatch for local Kev", async () => {
  const fetch = mockJsonResponse(response);
  await expect(plugin().evaluate(batch, context("kev-latest"))).resolves.toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("omits the bearer when the configured provider disables its auth header", async () => {
  const fetch = mockJsonResponse({ ...mixedFixture.localResponse, model: input.model });
  const provider = registered({
    models: {
      providers: {
        typesafe: {
          baseUrl: "https://decision.example.com/v1",
          apiKey: "synthetic-key",
          authHeader: false,
          models: [],
        },
      },
    },
  });
  await expect(provider.evaluate(batch, context())).resolves.toEqual(result);
  const { url, headers } = sent(fetch);
  expect(url).toBe("https://decision.example.com/v1/systemone");
  expect(headers.has("authorization")).toBe(false);
});

it.each([
  { answers: { c: response.answers.c, s: response.answers.s } },
  { answers: { ...response.answers, q: { type: "noul", noul: 1.01 } } },
  { usage: { input_tokens: "12", output_tokens: 3 } },
  { metrics: Array.from({ length: 65 }).reduce<unknown>((value) => [value], null) },
])("rejects an invalid native response %#", async (invalid) => {
  mockJsonResponse({ ...response, ...invalid });
  await expect(plugin().evaluate(batch, context())).resolves.toEqual({
    status: "unavailable",
    reason: "invalid-response",
  });
});

it("sends the configured local model name and accepts its name:tag report", async () => {
  const fetch = mockJsonResponse({ ...mixedFixture.localResponse, model: "tev1:4b" });
  await expect(
    plugin({ baseUrl: "http://192.168.2.17:11434", localModel: "tev1:4b" }).evaluate(
      batch,
      context("kev-latest", "typesafe-local"),
    ),
  ).resolves.toMatchObject({ status: "ok", result: { model: "tev1:4b" } });
  const { url, body } = sent(fetch);
  expect(url).toBe("http://192.168.2.17:11434/v1/systemone");
  expect(body).toHaveProperty("model", "tev1:4b");
});

it("rejects an invalid local model name", () => {
  expect(() => runtimeConfig({ baseUrl: localUrl, localModel: "tev1 4b" })).toThrow("localModel");
});

it("fills omitted instructions for a name-routed server, which rejects null", async () => {
  const fetch = mockJsonResponse({ ...mixedFixture.localResponse, model: "tev1:4b" });
  await plugin({ baseUrl: "http://192.168.2.17:11434", localModel: "tev1:4b" }).evaluate(
    batch,
    context("kev-latest", "typesafe-local"),
  );
  const { questions } = sent(fetch).body;
  expect(questions.c.instructions).toBe("Select the option that best matches the state.");
  expect(questions.s.instructions).toBe("Select the level that best matches the state.");
  expect(questions.q.instructions).toEqual({ question: "Escalate?" });
});

it.each([
  "http://127.0.0.1:8009/",
  "https://localhost",
  "http://192.168.1.2:8009",
  "http://10.0.0.5:11434",
  "http://172.31.255.1",
  "http://100.113.22.76:11434",
])("accepts an explicit loopback or private IPv4 origin %s", (url) => {
  expect(runtimeConfig({ baseUrl: url, apiKey: "ignored-secret" })).toEqual({
    baseUrl: new URL(url).origin,
    timeoutMs: 30000,
  });
});

it.each([
  "http://8.8.8.8:11434",
  "http://172.32.0.1",
  "http://100.128.0.1",
  "http://192.168.010.1",
  "http://10.0.0.256",
  "http://gpu.lan:11434",
  "https://remote.example",
  "http://localhost.example",
  "http://localhost:8009/v1",
  "http://localhost:8009?x=1",
  "http://localhost:8009#x",
  "file:///localhost",
  "http://localhost:65536",
  "http://127.1:8009",
  "http://2130706433:8009",
  "http://localhost.:8009",
  null,
])("rejects unsafe loopback endpoint %s", (url) => {
  expect(() => runtimeConfig({ baseUrl: url })).toThrow("baseUrl");
});
