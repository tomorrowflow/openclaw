import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  readGitHubPublicationFact,
  startGitHubPublicationDiscovery,
} from "./github-publication-discovery.js";
import { prepareGitHubPublicationFact } from "./worker-environments/worker-github-binding.js";

// mock-isolation: Count concurrent preparations without GitHub, Git, or session-store I/O.
vi.mock("./worker-environments/worker-github-binding.js", () => ({
  prepareGitHubPublicationFact: vi.fn(),
}));

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let owner: ReturnType<typeof startGitHubPublicationDiscovery> | undefined;
let active = 0;
let peak = 0;
let release: Array<() => void> = [];

beforeEach(() => {
  clock = createGatewaySchedulerClock(1_000);
  scheduler = createTestGatewayScheduler(clock.clock);
  active = 0;
  peak = 0;
  release = [];
  vi.mocked(prepareGitHubPublicationFact)
    .mockReset()
    .mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      active--;
      return { available: false };
    });
});

afterEach(async () => {
  for (const resolve of release.splice(0)) {
    resolve();
  }
  await owner?.stop();
  owner = undefined;
  await scheduler.stop();
});

const settle = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

async function drain(preparing: Promise<void> | void) {
  // Settle each held preparation so the next waiter takes its slot.
  for (let next = release.shift(); next; next = release.shift()) {
    next();
    await settle();
  }
  await preparing;
}

// Each preparation reads its session through the shared target-discovery worker lane
// (128 pending tasks); a config refresh covering every cached session must not fill it.
it("bounds publication refreshes while still refreshing every demanded session", async () => {
  owner = startGitHubPublicationDiscovery({ scheduler });
  const sessions = Array.from({ length: 200 }, (_, index) => ({
    agentId: "main",
    sessionKey: `agent:main:row-${index}`,
    sessionId: `session-${index}`,
  }));
  for (const session of sessions) {
    readGitHubPublicationFact(session);
  }
  const demanded = clock.wake();
  await settle();
  expect(active).toBe(4);
  await drain(demanded);
  expect(prepareGitHubPublicationFact).toHaveBeenCalledTimes(200);
  expect(peak).toBe(4);

  vi.mocked(prepareGitHubPublicationFact).mockClear();
  sessionChanges.emit({ all: true, scope: "config" });
  const refreshed = clock.wake();
  await settle();
  expect(active).toBe(4);
  await drain(refreshed);
  expect(prepareGitHubPublicationFact).toHaveBeenCalledTimes(200);
  expect(peak).toBe(4);
});
