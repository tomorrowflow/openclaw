import type { SandboxScope } from "./types.js";

export function resolveSandboxScope(params: { scope?: SandboxScope }): SandboxScope {
  return params.scope ?? "agent";
}

export function resolveSandboxDockerEnv<T>(params: {
  scope: SandboxScope;
  globalEnv?: Record<string, T>;
  agentEnv?: Record<string, T>;
}): Record<string, T | string> {
  const agentEnv = params.scope === "shared" ? undefined : params.agentEnv;
  return agentEnv
    ? { ...(params.globalEnv ?? { LANG: "C.UTF-8" }), ...agentEnv }
    : (params.globalEnv ?? { LANG: "C.UTF-8" });
}
