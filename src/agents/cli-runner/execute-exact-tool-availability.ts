import { parse as parseSemver } from "semver";
import { compareValidSemver } from "../../infra/semver.js";
import type { resolveCliExecutableIdentity } from "../cli-executable-identity.js";
import type { PreparedCliRunContext } from "./types.js";

export function exactToolAvailabilityError(params: {
  code: "unsupported" | "runtime-unavailable";
  isolatedCompletion: boolean;
  message: string;
}): Error {
  if (!params.isolatedCompletion) {
    return new Error(params.message);
  }
  return Object.assign(new Error(params.message), {
    name: "IsolatedCompletionRuntimeError",
    code: params.code,
  });
}

export function assertExactToolAvailabilityRuntimeVersion(params: {
  backendId: string;
  policy: NonNullable<
    PreparedCliRunContext["backendResolved"]["runtimeArtifact"]
  >["exactToolAvailabilityVersionPolicy"];
  executableIdentity: Awaited<ReturnType<typeof resolveCliExecutableIdentity>>;
  isolatedCompletion: boolean;
}): void {
  const artifact = params.executableIdentity?.runtimeArtifact;
  const packageVersion = artifact?.kind === "package-tree" ? artifact.packageVersion : undefined;
  const parsedVersion = packageVersion ? parseSemver(packageVersion) : null;
  const prereleaseChannel = parsedVersion?.prerelease[0];
  const minimumVersion =
    parsedVersion?.prerelease.length === 0
      ? params.policy?.stableMinimum
      : typeof prereleaseChannel === "string"
        ? params.policy?.prereleaseMinimums?.[prereleaseChannel]
        : undefined;
  const comparison =
    packageVersion && minimumVersion ? compareValidSemver(packageVersion, minimumVersion) : null;
  if (comparison !== null && comparison >= 0) {
    return;
  }
  throw exactToolAvailabilityError({
    code: "unsupported",
    isolatedCompletion: params.isolatedCompletion,
    message: `CLI backend ${params.backendId} requires a supported package version for exact per-run tool availability${minimumVersion ? ` (requires >=${minimumVersion}` : " (unsupported release line"}${packageVersion ? `; found ${packageVersion})` : ")"}`,
  });
}
