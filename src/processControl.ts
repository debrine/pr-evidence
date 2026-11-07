import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { CliError } from "./errors.js";

/**
 * Owns the lifecycle of a launched process tree: launch it, ask whether it is
 * still running, and stop it. Callers never touch platform primitives.
 *
 * The POSIX implementation runs the command with `sh -c` as a process group
 * leader, so the whole tree can be signalled through the group, and uses the
 * `ps` start time to tell the process apart from a later one with the same id.
 */

/** Identifies a launched process. Plain data, so it can be recorded and read back later. */
export interface ProcessIdentity {
  processId: number;
  /**
   * Tells this process apart from a later one that reuses its id. An opaque,
   * platform-specific value that is only ever compared, never parsed.
   */
  processStartTime: string | null;
}

export interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface LaunchedProcess {
  identity: ProcessIdentity;
  /** How the launched command exited, or null while it is still running. */
  exitStatus(): ProcessExit | null;
  /** Lets this CLI exit while the launched process keeps running. */
  release(): void;
}

const stopGraceMilliseconds = 5_000;
const stopPollMilliseconds = 50;

/**
 * Runs `command` through the shell in `cwd`, with stdout and stderr appended
 * to `logPath`. Rejects with an `app_exited` CliError if the command could not
 * be launched at all.
 */
export async function launchProcess(
  command: string,
  options: { cwd: string; logPath: string },
): Promise<LaunchedProcess> {
  const logDescriptor = openSync(options.logPath, "a");
  const child = spawn("sh", ["-c", command], {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  closeSync(logDescriptor);
  try {
    await once(child, "spawn");
  } catch (error) {
    throw new CliError("app_exited", `Could not launch the start command: ${command}. ${String(error)}`);
  }
  const processId = child.pid!;
  return {
    identity: { processId, processStartTime: readProcessStartTime(processId) },
    exitStatus: () =>
      child.exitCode === null && child.signalCode === null
        ? null
        : { exitCode: child.exitCode, signal: child.signalCode },
    release: () => child.unref(),
  };
}

/** Whether the process tree is still running and is still the one that was launched. */
export function isProcessRunning(identity: ProcessIdentity): boolean {
  if (!isProcessGroupAlive(identity.processId)) {
    return false;
  }
  const currentStartTime = readProcessStartTime(identity.processId);
  return currentStartTime === null || currentStartTime === identity.processStartTime;
}

/**
 * Stops the process tree, and only if it is still the one that was launched.
 * Returns whether a stop was sent.
 */
export async function stopProcess(identity: ProcessIdentity): Promise<boolean> {
  if (!isProcessRunning(identity)) {
    return false;
  }

  const processGroupId = identity.processId;
  process.kill(-processGroupId, "SIGTERM");
  const deadline = Date.now() + stopGraceMilliseconds;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) {
      return true;
    }
    await sleep(stopPollMilliseconds);
  }
  process.kill(-processGroupId, "SIGKILL");
  return true;
}

function readProcessStartTime(processId: number): string | null {
  try {
    const startTime = execFileSync("ps", ["-o", "lstart=", "-p", String(processId)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return startTime === "" ? null : startTime;
  } catch {
    return null;
  }
}

/** The process id is also the process group id, because the command is launched as a group leader. */
function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
