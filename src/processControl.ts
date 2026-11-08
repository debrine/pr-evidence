import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CliError } from "./errors.js";

/**
 * Owns the lifecycle of a launched process tree: launch it, ask whether it is
 * still running, and stop it. Callers never touch platform primitives.
 *
 * On POSIX the command runs with `sh -c` as a process group leader, so the
 * whole tree can be signalled through the group, and the `ps` start time tells
 * the process apart from a later one with the same id.
 *
 * On Windows the command runs with the `sh.exe` from Git for Windows, the tree
 * is stopped with `taskkill /T`, and the start time comes from PowerShell's
 * `Get-Process`. `taskkill /T` follows parent ids when it runs, so children of
 * a process that already exited are missed.
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

/** The shell Windows needs to run the start command, and how to get it. */
export const windowsShellPrerequisite = {
  name: "sh.exe",
  fix: "Install Git for Windows from https://git-scm.com/download/win. The start command runs with its sh.exe, found from `git --exec-path`.",
};

/** What one platform provides. The shared logic below is written once against it. */
interface Platform {
  /** Runs `command` in a shell, as the root of a tree that can be stopped as a whole. */
  spawnShell(command: string, options: { cwd: string; logDescriptor: number }): ChildProcess;
  /** Whether the launched tree is still alive. */
  isAlive(processId: number): boolean;
  readStartTime(processId: number): string | null;
  /**
   * Whether a live process whose start time cannot be read counts as the
   * launched one. When it does not, the tool refuses to stop it.
   */
  trustsUnreadableStartTime: boolean;
  /** Asks the tree to exit. */
  requestStop(processId: number): void;
  /** Ends what is left of the tree. */
  forceStop(processId: number): void;
}

const posix: Platform = {
  spawnShell: (command, { cwd, logDescriptor }) =>
    spawn("sh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
    }),
  // The process id is also the process group id, because the command is launched as a group leader.
  isAlive: (processGroupId) => isSignallable(-processGroupId),
  readStartTime: (processId) => readCommandOutput("ps", ["-o", "lstart=", "-p", String(processId)]),
  trustsUnreadableStartTime: true,
  requestStop: (processGroupId) => process.kill(-processGroupId, "SIGTERM"),
  forceStop: (processGroupId) => process.kill(-processGroupId, "SIGKILL"),
};

const windows: Platform = {
  spawnShell: (command, { cwd, logDescriptor }) => {
    const shell = findWindowsShell();
    if (shell === null) {
      throw new CliError(
        "missing_prerequisite",
        `${windowsShellPrerequisite.name} is required. ${windowsShellPrerequisite.fix}`,
      );
    }
    return spawn(shell, ["-c", command], {
      cwd,
      // Otherwise Node ends the app when this CLI exits.
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
  },
  isAlive: isSignallable,
  readStartTime: (processId) =>
    readCommandOutput(windowsSystemProgram("WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // Imported by path, because finding it through PSModulePath can take over 20 seconds when that is unset.
      "Import-Module \"$PSHOME\\Modules\\Microsoft.PowerShell.Management\"; " +
        `(Get-Process -Id ${processId} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
    ]),
  trustsUnreadableStartTime: false,
  requestStop: (processId) => runTaskkill(processId, []),
  forceStop: (processId) => runTaskkill(processId, ["/F"]),
};

const platform = process.platform === "win32" ? windows : posix;
const stopGraceMilliseconds = 5_000;
const stopPollMilliseconds = 50;

/**
 * Runs `command` through the shell in `cwd`, with stdout and stderr appended
 * to `logPath`. Rejects with an `app_exited` CliError if the command could not
 * be launched at all, or `missing_prerequisite` when there is no shell to run it.
 */
export async function launchProcess(
  command: string,
  options: { cwd: string; logPath: string },
): Promise<LaunchedProcess> {
  // Not append mode: Git for Windows' sh.exe drops what it writes to an append-only handle.
  // The run directory is new for each launch, so there is nothing earlier to keep.
  const logDescriptor = openSync(options.logPath, "w");
  let child: ChildProcess;
  try {
    child = platform.spawnShell(command, { cwd: options.cwd, logDescriptor });
  } finally {
    closeSync(logDescriptor);
  }
  try {
    await once(child, "spawn");
  } catch (error) {
    throw new CliError("app_exited", `Could not launch the start command: ${command}. ${String(error)}`);
  }
  const processId = child.pid!;
  return {
    identity: { processId, processStartTime: platform.readStartTime(processId) },
    exitStatus: () =>
      child.exitCode === null && child.signalCode === null
        ? null
        : { exitCode: child.exitCode, signal: child.signalCode },
    release: () => child.unref(),
  };
}

/** Whether the process tree is still running and may still be the one that was launched. */
export function isProcessRunning(identity: ProcessIdentity): boolean {
  const ownership = checkOwnership(identity);
  // A process that cannot be confirmed may be the app, so it is kept rather than forgotten.
  return ownership === "launched" || ownership === "unconfirmed";
}

/**
 * Stops the process tree, and only if it is still the one that was launched.
 * Returns whether a stop was sent. Throws an `app_not_confirmed` CliError,
 * without stopping anything, when a live process cannot be confirmed as the app.
 */
export async function stopProcess(identity: ProcessIdentity): Promise<boolean> {
  const ownership = checkOwnership(identity);
  if (ownership === "unconfirmed") {
    throw new CliError(
      "app_not_confirmed",
      `Process ${identity.processId} is running, but could not be confirmed as the app this tool started, so it was not stopped. If it is the app, stop it yourself.`,
    );
  }
  if (ownership !== "launched") {
    return false;
  }

  platform.requestStop(identity.processId);
  const deadline = Date.now() + stopGraceMilliseconds;
  while (Date.now() < deadline) {
    if (!platform.isAlive(identity.processId)) {
      return true;
    }
    await sleep(stopPollMilliseconds);
  }
  platform.forceStop(identity.processId);
  return true;
}

/** Whether the process is ours. `gone` and `other` both mean nothing of ours is left to stop. */
function checkOwnership(identity: ProcessIdentity): "gone" | "launched" | "other" | "unconfirmed" {
  if (!platform.isAlive(identity.processId)) {
    return "gone";
  }
  const currentStartTime = platform.readStartTime(identity.processId);
  const startTimeUnreadable = currentStartTime === null || identity.processStartTime === null;
  if (startTimeUnreadable && !platform.trustsUnreadableStartTime) {
    return "unconfirmed";
  }
  return currentStartTime === null || currentStartTime === identity.processStartTime ? "launched" : "other";
}

/**
 * The `sh.exe` of the Git for Windows install that `git` belongs to, or null.
 * Never looked up on PATH, where `bash.exe` in the Windows directory is the WSL launcher.
 */
export function findWindowsShell(): string | null {
  // Such as C:/Program Files/Git/mingw64/libexec/git-core, three levels below the install.
  const gitExecPath = readCommandOutput("git", ["--exec-path"]);
  if (gitExecPath === null) {
    return null;
  }
  const shell = join(resolve(gitExecPath, "..", "..", ".."), "usr", "bin", "sh.exe");
  return existsSync(shell) ? shell : null;
}

/** Signal 0 only checks that the process, or with a negative id the group, exists. */
function isSignallable(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Trimmed stdout of a successful run, or null when it failed or printed nothing. */
function readCommandOutput(command: string, args: string[]): string | null {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

/** A program in the Windows system directory, by full path so that PATH cannot replace it. */
function windowsSystemProgram(...pathInSystem32: string[]): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...pathInSystem32);
}

function runTaskkill(processId: number, extraArgs: string[]): void {
  try {
    execFileSync(windowsSystemProgram("taskkill.exe"), ["/PID", String(processId), "/T", ...extraArgs], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // Ignored, because the polling and the forced stop that follow decide the outcome.
  }
}
