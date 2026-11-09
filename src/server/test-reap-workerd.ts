import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * PIDs of workerd processes left behind by an earlier run: parent is init (1)
 * and the binary is this repo's own. A run killed before its teardown -- a
 * timed-out command, a Ctrl-C mid-suite -- orphans its workerd, and nothing
 * else ever stops it. A running `pnpm run dev` keeps its parent, so it is
 * never matched.
 */
export const orphanedWorkerd = (psOutput: string, nodeModules: string): number[] =>
  psOutput.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) return [];
    const [, pid = "", ppid = "", command = ""] = match;
    return ppid === "1" && command.startsWith(nodeModules) && command.includes("workerd")
      ? [Number(pid)]
      : [];
  });

/** Vitest globalSetup: clears orphans before the suite starts its own. */
export default function reapOrphanedWorkerd(): void {
  // ponytail: ps is POSIX-only; on Windows this is skipped and orphans stay.
  if (process.platform === "win32") return;
  const nodeModules = resolve(import.meta.dirname, "../../node_modules");
  const ps = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  for (const pid of orphanedWorkerd(ps, nodeModules)) {
    try {
      process.kill(pid);
    } catch (cause) {
      // Already gone between ps and kill: nothing left to stop.
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
    }
  }
}
