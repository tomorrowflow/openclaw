import type { SandboxDockerSettings } from "../../config/types.sandbox.js";

type RequiredDockerConfigKeys =
  | "image"
  | "containerPrefix"
  | "workdir"
  | "readOnlyRoot"
  | "tmpfs"
  | "network"
  | "capDrop";

export type SandboxDockerConfig = Omit<SandboxDockerSettings, RequiredDockerConfigKeys | "env"> &
  Required<Pick<SandboxDockerSettings, RequiredDockerConfigKeys>> & {
    /** Resolved container environment; SecretRef inputs arrive as runtime snapshot strings. */
    env?: Record<string, string>;
  };
