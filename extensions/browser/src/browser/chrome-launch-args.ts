/**
 * Chrome launch argument composition for the managed OpenClaw browser.
 *
 * Owns the switch list handed to a locally launched Chromium, including how
 * operator `browser.extraArgs` combine with the switches OpenClaw sets itself.
 */
import { hasChromeProxyControlArg } from "./browser-proxy-mode.js";
import {
  type ResolvedBrowserConfig,
  type ResolvedBrowserProfile,
  resolveManagedBrowserHeadlessMode,
} from "./config.js";

/** Features the managed profile always disables, merged with operator extraArgs. */
const MANAGED_DISABLED_CHROME_FEATURES = ["Translate", "MediaRouter"] as const;

function isDisableFeaturesArg(arg: string): boolean {
  const normalized = arg.trim().toLowerCase();
  // A valueless occurrence disables nothing but still replaces our value.
  return normalized === "--disable-features" || normalized.startsWith("--disable-features=");
}

/**
 * Chromium keeps one value per switch, so a later --disable-features replaces
 * the earlier one instead of adding to it. An operator flag passed through
 * extraArgs would therefore silently re-enable Translate and MediaRouter. Fold
 * both sides into the single occurrence Chromium actually reads, and drop the
 * operator's own occurrences from the appended tail.
 */
function mergeChromeDisabledFeatures(extraArgs: readonly string[]): {
  disableFeaturesArg: string;
  remainingExtraArgs: string[];
} {
  const features = new Set<string>(MANAGED_DISABLED_CHROME_FEATURES);
  const remainingExtraArgs: string[] = [];
  for (const arg of extraArgs) {
    if (!isDisableFeaturesArg(arg)) {
      remainingExtraArgs.push(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    if (separator < 0) {
      continue;
    }
    for (const feature of arg.slice(separator + 1).split(",")) {
      const trimmed = feature.trim();
      if (trimmed) {
        features.add(trimmed);
      }
    }
  }
  return {
    disableFeaturesArg: `--disable-features=${[...features].join(",")}`,
    remainingExtraArgs,
  };
}

/** Build Chrome launch arguments for the managed OpenClaw browser. */
export function buildOpenClawChromeLaunchArgs(params: {
  resolved: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
  headlessOverride?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  useMockKeychain?: boolean;
}): string[] {
  const { resolved, profile, userDataDir } = params;
  const platform = params.platform ?? process.platform;
  const headlessMode = resolveManagedBrowserHeadlessMode(resolved, profile, params);
  const { disableFeaturesArg, remainingExtraArgs } = mergeChromeDisabledFeatures(
    resolved.extraArgs,
  );
  const args: string[] = [
    `--remote-debugging-port=${profile.cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    disableFeaturesArg,
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--password-store=basic",
  ];

  if (platform === "darwin" && params.useMockKeychain) {
    // This is an isolated OpenClaw-owned profile, not the user's Chrome profile.
    // Keep its basic password store non-interactive so headless Chrome can
    // encrypt and persist cookies without login-keychain prompts.
    args.push("--use-mock-keychain");
  }
  if (headlessMode.headless) {
    args.push("--headless=new");
    args.push("--disable-gpu");
  }
  if (resolved.noSandbox) {
    args.push("--no-sandbox");
  }
  if (platform === "linux") {
    args.push("--disable-dev-shm-usage");
  }
  if (!hasChromeProxyControlArg(resolved.extraArgs)) {
    args.push("--no-proxy-server");
  }
  if (remainingExtraArgs.length > 0) {
    args.push(...remainingExtraArgs);
  }

  return args;
}
