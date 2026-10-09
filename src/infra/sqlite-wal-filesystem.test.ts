import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeTreeClone } from "@openclaw/fs-safe/copy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolvePathJournalPolicy } from "./sqlite-wal-filesystem.js";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("@openclaw/fs-safe/copy", { spy: true });

describe("SQLite filesystem classification", () => {
  afterEach(() => vi.restoreAllMocks());

  it("classifies unaliased macOS APFS paths without listing mounts", () => {
    const tempDir = fs.realpathSync(tempDirs.make("openclaw-sqlite-apfs-"));
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    vi.mocked(probeTreeClone).mockReturnValue("apfs");
    // `mount` stalls in the kernel while a network share hangs; it must not be consulted.
    const listMounts = vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.from(""));

    expect(resolvePathJournalPolicy(path.join(tempDir, "openclaw.sqlite"))).toBe("wal");
    expect(listMounts).not.toHaveBeenCalled();
  });
});

describe("SQLite mount timeout", () => {
  afterEach(() => vi.restoreAllMocks());
  it.runIf(process.platform !== "win32").each(["apfs", "unknown", "failed", "aliased"])(
    "preserves a WAL peer through a mount timeout only with canonical APFS evidence: %s",
    (classification) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-wal-mount-timeout-"));
      const directory = path.join(root, "database");
      fs.mkdirSync(directory);
      const alias = path.join(root, "alias");
      if (classification === "aliased") {
        fs.symlinkSync(directory, alias);
      }
      const databasePath = path.join(
        classification === "aliased" ? alias : directory,
        "state.sqlite",
      );
      const { DatabaseSync } = requireNodeSqlite();
      const first = new DatabaseSync(databasePath);
      first.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT);");
      const second = new DatabaseSync(databasePath);
      let maintenance: ReturnType<typeof configureSqliteWalMaintenance> | undefined;
      try {
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        vi.spyOn(fs, "readFileSync").mockImplementation(() => {
          throw new Error("no proc mountinfo");
        });
        vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
          throw Object.assign(new Error("mount classification timed out"), { code: "ETIMEDOUT" });
        });
        vi.mocked(probeTreeClone).mockImplementation(() => {
          if (classification === "failed") {
            throw new Error("native filesystem inspection failed");
          }
          return classification === "unknown" ? undefined : "apfs";
        });
        const configure = () =>
          configureSqliteWalMaintenance(second, { databasePath, checkpointIntervalMs: 0 });
        if (classification === "apfs") {
          maintenance = configure();
          second.exec("INSERT INTO records VALUES ('second');");
        } else {
          expect(configure).toThrow(/database is locked/);
        }
        first.exec("INSERT INTO records VALUES ('first');");
        expect(first.prepare("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "wal" });
        expect(first.prepare("SELECT value FROM records ORDER BY value").all()).toEqual(
          classification === "apfs"
            ? [{ value: "first" }, { value: "second" }]
            : [{ value: "first" }],
        );
      } finally {
        maintenance?.close();
        second.close();
        first.close();
      }
    },
  );
});
