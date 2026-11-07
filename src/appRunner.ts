import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { CliError } from "./errors.js";
import {
  launchProcess,
  stopProcess,
  type LaunchedProcess,
  type ProcessIdentity,
} from "./processControl.js";

const defaultReadyTimeoutMilliseconds = 120_000;
const readyPollMilliseconds = 250;
const probeTimeoutMilliseconds = 2_000;
const appOutputCharacters = 4_000;

function readyTimeoutMilliseconds(): number {
  const override = Number(process.env.PR_EVIDENCE_READY_TIMEOUT_MS);
  return override > 0 ? override : defaultReadyTimeoutMilliseconds;
}

/** The HTTP status from `url`, or null when nothing answered. */
export async function probeUrl(url: string, signal?: AbortSignal): Promise<number | null> {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(signal?.reason);
  const timeout = setTimeout(() => cancellation.abort(), probeTimeoutMilliseconds);
  timeout.unref();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const response = await fetch(url, {
      signal: cancellation.signal,
      redirect: "manual",
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

function readAppOutput(logPath: string): string {
  if (!existsSync(logPath)) return "";
  const descriptor = openSync(logPath, "r");
  try {
    const size = fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size, appOutputCharacters * 4));
    const position = size - buffer.length;
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, position + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return buffer.subarray(0, bytesRead).toString("utf8").slice(-appOutputCharacters);
  } finally {
    closeSync(descriptor);
  }
}

async function waitUntilReady(
  url: string,
  app: LaunchedProcess,
  logPath: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + readyTimeoutMilliseconds();
  let status: number | null = null;
  while (true) {
    signal.throwIfAborted();
    const exitStatus = app.exitStatus();
    if (exitStatus !== null) {
      const exitDescription = exitStatus.signal === null
        ? `code ${exitStatus.exitCode}`
        : `signal ${exitStatus.signal}`;
      throw new CliError(
        "app_exited",
        `The start command exited with ${exitDescription}. The command must stay in the foreground; detached apps it leaves behind are not managed.`,
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
 * Starts the app and waits until it is ready. `onStarted` runs as soon as the
 * process exists, so it can be recorded and stopped even if readiness fails.
 */
export async function startApp(
  command: string,
  options: {
    cwd: string;
    logPath: string;
    readyUrl: string;
    onStarted: (app: ProcessIdentity) => void;
    onStopped: () => void;
  },
): Promise<void> {
  const cancellation = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => cancellation.abort(
    new CliError("app_interrupted", `Startup interrupted by ${signal}.`),
  );
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let app: LaunchedProcess | undefined;
  try {
    app = await launchProcess(command, { cwd: options.cwd, logPath: options.logPath });
    options.onStarted(app.identity);
    await waitUntilReady(options.readyUrl, app, options.logPath, cancellation.signal);
    cancellation.signal.throwIfAborted();
    app.release();
  } catch (error) {
    if (app) {
      await stopProcess(app.identity);
      options.onStopped();
    }
    throw cancellation.signal.aborted ? cancellation.signal.reason : error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
