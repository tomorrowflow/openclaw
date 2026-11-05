import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerGatewayCli } from "./register.js";

async function parseInstallForce(program: Command) {
  program.exitOverride();
  registerGatewayCli(program);
  const gateway = program.commands.find((command) => command.name() === "gateway");
  const install = gateway?.commands.find((command) => command.name() === "install");
  let seen: { force?: boolean } | undefined;
  install?.action((opts: { force?: boolean }) => {
    seen = opts;
  });
  await program.parseAsync(["gateway", "install", "--force"], { from: "user" });
  return seen;
}

describe("gateway install --force", () => {
  it("reaches install when the root program enables positional options", async () => {
    await expect(parseInstallForce(new Command().enablePositionalOptions())).resolves.toMatchObject(
      { force: true },
    );
  });
});
