#!/usr/bin/env node
// Deploy-time recovery for a dist artifact lock that an interrupted build left
// behind (scripts/lib/dist-artifact-lock.mts). The lock fails closed on a dead
// owner by design, because detached compilers can outlive it, and tells the
// operator to release it once nothing runs in the checkout. The deploy scripts
// own their checkout, so they make that check here instead of failing the build.
//
// Usage: node scripts/release-stale-dist-lock.mjs [checkout]   (default: cwd)
// Exits 0 when there is no lock, its owner is alive (the build waits for it),
// or it was released; exits 1 when processes the dead build may have started
// still run in the checkout.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const checkout = fs.realpathSync(process.argv[2] ?? process.cwd());
const lockDir = path.join(checkout, ".artifacts/dist-artifacts.lock");
const ownerPath = path.join(lockDir, "owner.json");
// A released lock leaves its directory behind; only the owner record and the
// child claims hold it.
const holders = fs.existsSync(lockDir)
  ? fs.readdirSync(lockDir).filter((name) => name === "owner.json" || /^child-\d+$/.test(name))
  : [];
if (holders.length === 0) {
  process.exit(0);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

let owner = {};
try {
  owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
} catch {
  // A missing or torn owner record is no live owner.
}
// When the lock was taken: the owner's record, else the oldest holder file.
const lockedAt = (() => {
  const recorded = Date.parse(owner.startedAt);
  if (!Number.isNaN(recorded)) {
    return recorded;
  }
  return Math.min(...holders.map((name) => fs.statSync(path.join(lockDir, name)).mtimeMs));
})();

// lstart has whole seconds; undefined when the process is gone or unreadable.
function startOf(pid) {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    const at = Date.parse(started);
    return Number.isNaN(at) ? undefined : at;
  } catch {
    return undefined;
  }
}
// The build and everything it starts began after it took the lock. A process
// older than that is not its work: an idle shell or editor in the checkout, or
// an unrelated process that reuses the dead owner's PID.
const startedAfterLock = (pid) => {
  const started = startOf(pid);
  return started === undefined || started >= lockedAt - 1000;
};
if (
  Number.isSafeInteger(owner.pid) &&
  owner.pid > 1 &&
  alive(owner.pid) &&
  !(startOf(owner.pid) > lockedAt + 1000)
) {
  process.exit(0);
}

const processes = execFileSync("ps", ["-axwwo", "pid=,ppid=,command="], { encoding: "utf8" })
  .split("\n")
  .flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
const byPid = new Map(processes.map((entry) => [entry.pid, entry]));

function cwdOf(pid) {
  if (process.platform === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // Another user's process; the checkout and its builds belong to this one.
      return undefined;
    }
  }
  return macCwds.get(pid);
}
const macCwds = new Map();
if (process.platform !== "linux") {
  let listing;
  try {
    // By path: the satellite deploy's PATH has no /usr/sbin.
    listing = execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // lsof exits 1 when it skips processes it may not inspect; its output stands.
    listing = error.stdout;
  }
  if (!listing) {
    console.error(`[dist artifacts] cannot list process directories; leaving ${lockDir} in place.`);
    process.exit(1);
  }
  let pid;
  for (const field of listing.split("\n")) {
    if (field.startsWith("p")) {
      pid = Number(field.slice(1));
    } else if (field.startsWith("n") && pid !== undefined) {
      macCwds.set(pid, field.slice(1));
    }
  }
}

const inCheckout = (dir) => dir === checkout || dir?.startsWith(`${checkout}/`);

// The deploy itself runs in the checkout: spare the subtree of the unbroken
// chain of ancestors that do. An interrupted build was reparented away from it.
let root = process.pid;
for (let pid = process.ppid; pid > 1 && inCheckout(cwdOf(pid)); pid = byPid.get(pid)?.ppid ?? 0) {
  root = pid;
}
const spared = new Set([root]);
for (let grew = true; grew;) {
  grew = false;
  for (const entry of processes) {
    if (!spared.has(entry.pid) && spared.has(entry.ppid)) {
      spared.add(entry.pid);
      grew = true;
    }
  }
}

const claims = fs
  .readdirSync(lockDir)
  .flatMap((name) => (/^child-\d+$/.test(name) ? [Number(name.slice(6))] : []))
  .filter(alive);
const busy = processes.filter(
  (entry) =>
    !spared.has(entry.pid) &&
    (claims.includes(entry.pid) ||
      ((inCheckout(cwdOf(entry.pid)) ||
        ` ${entry.command} `.includes(` ${checkout} `) ||
        entry.command.includes(`${checkout}/`)) &&
        startedAfterLock(entry.pid))),
);
if (busy.length > 0 || claims.length > 0) {
  console.error(
    `[dist artifacts] ${lockDir} is held by dead PID ${owner.pid ?? "unknown"}, but these processes still run in ${checkout}:`,
  );
  for (const entry of busy) {
    console.error(`  ${entry.pid} ${entry.command.slice(0, 160)}`);
  }
  for (const pid of claims.filter((claim) => !busy.some((entry) => entry.pid === claim))) {
    console.error(`  ${pid} (a live build claim in ${lockDir})`);
  }
  console.error("Stop them (or wait for them to finish), then rerun the deploy.");
  process.exit(1);
}

fs.rmSync(lockDir, { recursive: true, force: true });
console.error(
  `[dist artifacts] released a stale lock left by PID ${owner.pid ?? "unknown"} (started ${owner.startedAt ?? "unknown"}); nothing runs in ${checkout}`,
);
