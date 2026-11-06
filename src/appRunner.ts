import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { CliError } from "./errors.js";

export interface AppProcess {
  /** Also the process group id, because the app is spawned as a group leader. */
  processId: number;
  /** Tells this process apart from a later one that reuses its id. */
  processStartTime: string | null;
}

const defaultReadyTimeoutMilliseconds = 120_000;
const readyPollMilliseconds = 250;
const probeTimeoutMilliseconds = 2_000;
const stopGraceMilliseconds = 5_000;
const appOutputCharacters = 4_000;

function readyTimeoutMilliseconds(): number {
  const override = Number(process.env.PR_EVIDENCE_READY_TIMEOUT_MS);
  return override > 0 ? override : defaultReadyTimeoutMilliseconds;
}

/** The HTTP status from `url`, or null when nothing answered. */
export async function probeUrl(url: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([
        AbortSignal.timeout(probeTimeoutMilliseconds),
        ...(signal ? [signal] : []),
      ]),
      redirect: "manual",
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
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

function readAppOutput(logPath: string): string {
  return existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-appOutputCharacters) : "";
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntilReady(
  url: string,
  child: ChildProcess,
  logPath: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + readyTimeoutMilliseconds();
  let status: number | null = null;
  while (true) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) {
      const exit = child.signalCode === null ? `code ${child.exitCode}` : `signal ${child.signalCode}`;
      throw new CliError(
        "app_exited",
        `The start command exited with ${exit}. The command must stay in the foreground; detached apps it leaves behind are not managed.`,
        { appOutput: readAppOutput(logPath) },
      );
    }
    if (status !== null && status < 500) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        "app_not_ready",
        `${url} was not ready within ${readyTimeoutMilliseconds() / 1000} seconds.`,
        { appOutput: readAppOutput(logPath) },
      );
    }
    status = await probeUrl(url, signal);
    if (status === null || status >= 500) {
      await sleep(readyPollMilliseconds, undefined, { signal });
    }
  }
}

/**
 * Starts the app in its own process group. `onStarted` runs as soon as the
 * process exists, so it can be recorded and stopped even if readiness fails.
 */
export async function startApp(
  command: string,
  options: {
    cwd: string;
    logPath: string;
    readyUrl: string;
    onStarted: (app: AppProcess) => void;
    onStopped: () => void;
  },
): Promise<AppProcess> {
  const logDescriptor = openSync(options.logPath, "a");
  const child = spawn("sh", ["-c", command], {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  closeSync(logDescriptor);
  const cancellation = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => cancellation.abort(
    new CliError("app_interrupted", `Startup interrupted by ${signal}.`),
  );
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let app: AppProcess | undefined;
  try {
    try {
      await once(child, "spawn");
    } catch (error) {
      throw new CliError("app_exited", `Could not launch the start command: ${command}. ${String(error)}`);
    }
    const processId = child.pid!;
    app = { processId, processStartTime: readProcessStartTime(processId) };
    options.onStarted(app);
    await waitUntilReady(options.readyUrl, child, options.logPath, cancellation.signal);
    cancellation.signal.throwIfAborted();
    child.unref();
    return app;
  } catch (error) {
    if (app) {
      await stopApp(app);
      options.onStopped();
    }
    throw cancellation.signal.aborted ? cancellation.signal.reason : error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

export function isAppRunning(app: AppProcess): boolean {
  if (!isProcessGroupAlive(app.processId)) {
    return false;
  }
  const currentStartTime = readProcessStartTime(app.processId);
  return currentStartTime === null || currentStartTime === app.processStartTime;
}

/** Stops the process group, and only if it is still the one that was started. */
export async function stopApp(app: AppProcess): Promise<boolean> {
  if (!isAppRunning(app)) {
    return false;
  }

  process.kill(-app.processId, "SIGTERM");
  const deadline = Date.now() + stopGraceMilliseconds;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(app.processId)) {
      return true;
    }
    await sleep(50);
  }
  process.kill(-app.processId, "SIGKILL");
  return true;
}
