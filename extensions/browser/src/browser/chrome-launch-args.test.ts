// Browser tests cover managed Chrome launch argument composition.
import { describe, expect, it } from "vitest";
import { buildOpenClawChromeLaunchArgs } from "./chrome-launch-args.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";

const makeProfile = (): ResolvedBrowserProfile =>
  ({
    name: "openclaw",
    color: "#FF4500",
    cdpPort: 18_800,
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    driver: "openclaw",
    attachOnly: false,
  }) as unknown as ResolvedBrowserProfile;

const makeResolved = (overrides: Partial<ResolvedBrowserConfig> = {}): ResolvedBrowserConfig =>
  ({
    headless: true,
    noSandbox: false,
    extraArgs: [],
    ...overrides,
  }) as unknown as ResolvedBrowserConfig;

const buildArgs = (extraArgs: string[]): string[] =>
  buildOpenClawChromeLaunchArgs({
    resolved: makeResolved({ extraArgs }),
    profile: makeProfile(),
    userDataDir: "/tmp/openclaw-profile",
    platform: "linux",
  });

const disableFeaturesArgs = (args: string[]): string[] =>
  args.filter((arg) => arg.startsWith("--disable-features="));

describe("buildOpenClawChromeLaunchArgs", () => {
  it("disables the managed profile's own features when no extraArgs are set", () => {
    expect(disableFeaturesArgs(buildArgs([]))).toEqual([
      "--disable-features=Translate,MediaRouter",
    ]);
  });

  it("merges operator --disable-features into the single flag Chromium reads", () => {
    // Chromium keeps one value per switch, so a second occurrence would drop
    // Translate and MediaRouter rather than add to them.
    const args = buildArgs(["--disable-features=IsolateOrigins,site-per-process", "--no-pings"]);

    expect(disableFeaturesArgs(args)).toEqual([
      "--disable-features=Translate,MediaRouter,IsolateOrigins,site-per-process",
    ]);
    expect(args).toContain("--no-pings");
  });

  it("folds repeated and duplicate operator occurrences into one flag", () => {
    const args = buildArgs(["--disable-features=A", "--disable-features=Translate,B"]);

    expect(disableFeaturesArgs(args)).toEqual(["--disable-features=Translate,MediaRouter,A,B"]);
  });

  it("drops a valueless operator occurrence that would clear the value", () => {
    const args = buildArgs(["--disable-features"]);

    expect(disableFeaturesArgs(args)).toEqual(["--disable-features=Translate,MediaRouter"]);
    expect(args).not.toContain("--disable-features");
  });

  it("keeps unrelated extraArgs and the default proxy control flag", () => {
    const args = buildArgs(["--window-size=1920,1080"]);

    expect(args).toContain("--window-size=1920,1080");
    expect(args).toContain("--no-proxy-server");
  });

  it("yields to an operator proxy flag instead of forcing a direct connection", () => {
    const args = buildArgs(["--proxy-server=http://127.0.0.1:3128"]);

    expect(args).toContain("--proxy-server=http://127.0.0.1:3128");
    expect(args).not.toContain("--no-proxy-server");
  });
});
