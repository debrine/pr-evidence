import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const processListMaxBytes = 64 * 1024 * 1024;
const survivorGraceMilliseconds = 5_000;
const survivorPollMilliseconds = 250;
const appReadyTimeoutMilliseconds = 10_000;
const appReadyPollMilliseconds = 100;
// The first run downloads chrome-devtools-mcp inside this window, and the default is 30 seconds.
const bridgeStartTimeoutMilliseconds = 180_000;
const sampleAppPath = fileURLToPath(new URL("./app.mjs", import.meta.url));
const browserPackagePath = createRequire(import.meta.url).resolve("chrome-devtools-axi/package.json");
const browserPackageDirectory = dirname(browserPackagePath);
const browserPackageVersion = (JSON.parse(readFileSync(browserPackagePath, "utf8")) as { version: string })
  .version;
const browserCliPath = join(browserPackageDirectory, "dist", "bin", "chrome-devtools-axi.js");
const browserBridgePath = join(browserPackageDirectory, "dist", "bin", "chrome-devtools-axi-bridge.js");

export type BrowserProcessKind = "bridge" | "chrome-devtools-mcp" | "chrome" | "other";

export interface BrowserProcess {
  processId: number;
  kind: BrowserProcessKind;
  commandLine: string;
}

export interface BrowserSmoke {
  appUrl: string;
  workDirectory: string;
  browser(...args: string[]): Promise<void>;
  trackBrowserProcesses(): Promise<BrowserProcess[]>;
  findSurvivors(): Promise<BrowserProcess[] | null>;
  cleanUp(): Promise<void>;
}

export interface BrowserSmokeFindings {
  survivors: BrowserProcess[] | null;
  reopened: boolean | null;
  reopenLaunchedNewChrome: boolean | null;
}

function describeSurvivors(survivors: BrowserProcess[] | null): string {
  if (survivors === null) return "not reached";
  if (survivors.length === 0) return "none";
  const counts = new Map<BrowserProcessKind, number>();
  for (const { kind } of survivors) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${kind} x${count}`).join(", ");
}

function describeOutcome(outcome: boolean | null): string {
  if (outcome === null) return "not reached";
  return outcome ? "yes" : "no";
}

function describeCleanupNeed({ survivors, reopened }: BrowserSmokeFindings): string {
  if (survivors === null || reopened === null) return "unknown, the run did not finish";
  return survivors.length > 0 || !reopened ? "yes" : "no";
}

export function formatBrowserSmokeReport(findings: BrowserSmokeFindings): string {
  const survivorLines = (findings.survivors ?? []).map(
    ({ processId, kind, commandLine }) => `- ${processId} (${kind}): \`${commandLine.slice(0, 160)}\``,
  );
  return [
    `## Browser smoke on ${process.platform}`,
    "",
    `- chrome-devtools-axi: ${browserPackageVersion}`,
    `- Survived \`chrome-devtools-axi stop\`: ${describeSurvivors(findings.survivors)}`,
    `- Reopened with the same profile: ${describeOutcome(findings.reopened)}`,
    `- Reopen launched a new Chrome: ${describeOutcome(findings.reopenLaunchedNewChrome)}`,
    `- Browser cleanup ticket needed: ${describeCleanupNeed(findings)}`,
    ...(survivorLines.length > 0 ? ["", "Surviving processes:", ...survivorLines] : []),
  ].join("\n");
}

interface RunningProcess {
  processId: number;
  parentProcessId: number;
  commandLine: string;
}

async function listWindowsProcesses(): Promise<RunningProcess[]> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", maxBuffer: processListMaxBytes },
  );
  const rows = JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number; CommandLine: string | null }[];
  return rows.map((row) => ({
    processId: row.ProcessId,
    parentProcessId: row.ParentProcessId,
    commandLine: row.CommandLine ?? "",
  }));
}

async function listPosixProcesses(): Promise<RunningProcess[]> {
  const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: processListMaxBytes,
  });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match
      ? [{ processId: Number(match[1]), parentProcessId: Number(match[2]), commandLine: match[3]! }]
      : [];
  });
}

function listProcesses(): Promise<RunningProcess[]> {
  return process.platform === "win32" ? listWindowsProcesses() : listPosixProcesses();
}

function classifyProcess(commandLine: string): BrowserProcessKind {
  const lowerCaseCommandLine = commandLine.toLowerCase();
  if (lowerCaseCommandLine.includes("chrome-devtools-axi-bridge")) return "bridge";
  if (lowerCaseCommandLine.includes("chrome-devtools-mcp")) return "chrome-devtools-mcp";
  if (lowerCaseCommandLine.includes("chrome")) return "chrome";
  return "other";
}

// chrome-devtools-mcp renames itself and Chrome's helpers omit the profile, so only the
// roots can be matched by command line. Everything else is found through its parent.
function selectBrowserProcessTree(processes: RunningProcess[], profileDirectory: string): RunningProcess[] {
  const rootMarkers = [profileDirectory, browserBridgePath].map((marker) => marker.toLowerCase());
  const selectedIds = new Set(
    processes
      .filter(({ commandLine }) =>
        rootMarkers.some((marker) => commandLine.toLowerCase().includes(marker)),
      )
      .map(({ processId }) => processId),
  );
  let selectedCount = 0;
  while (selectedCount !== selectedIds.size) {
    selectedCount = selectedIds.size;
    for (const { processId, parentProcessId } of processes) {
      if (selectedIds.has(parentProcessId)) selectedIds.add(processId);
    }
  }
  return processes.filter(({ processId }) => selectedIds.has(processId));
}

function isolatedBrowserEnvironment(profileDirectory: string, sessionName: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
  delete environment.CHROME_DEVTOOLS_AXI_BROWSER_URL;
  delete environment.CHROME_DEVTOOLS_AXI_MCP_SERVER_URL;
  environment.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = profileDirectory;
  environment.CHROME_DEVTOOLS_AXI_SESSION = sessionName;
  environment.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = String(bridgeStartTimeoutMilliseconds);
  return environment;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForApp(appUrl: string): Promise<void> {
  const deadline = Date.now() + appReadyTimeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await fetch(appUrl);
      return;
    } catch {
      await sleep(appReadyPollMilliseconds);
    }
  }
  throw new Error(`Sample app did not answer at ${appUrl}`);
}

function forceStopProcess(processId: number): Promise<unknown> {
  if (process.platform === "win32") {
    return execFileAsync("taskkill", ["/PID", String(processId), "/T", "/F"]).catch(() => undefined);
  }
  try {
    process.kill(processId, "SIGKILL");
  } catch {
    // Already gone.
  }
  return Promise.resolve();
}

export async function startBrowserSmoke(): Promise<BrowserSmoke> {
  // Windows runners report a short 8.3 temp path, which is not the path Chrome reports back.
  const workDirectory = realpathSync.native(mkdtempSync(join(tmpdir(), "pr-evidence-browser-smoke-")));
  const profileDirectory = join(workDirectory, "profile");
  const environment = isolatedBrowserEnvironment(profileDirectory, `pr-evidence-smoke-${process.pid}`);
  const port = await findFreePort();
  const app = spawn(process.execPath, [sampleAppPath, String(port), join(workDirectory, "app.pid")], {
    stdio: "ignore",
  });
  const appUrl = `http://127.0.0.1:${port}/`;
  try {
    await waitForApp(appUrl);
  } catch (error) {
    app.kill();
    throw error;
  }

  const trackedProcesses = new Map<number, BrowserProcess>();

  async function trackBrowserProcesses(): Promise<BrowserProcess[]> {
    const tree = selectBrowserProcessTree(await listProcesses(), profileDirectory);
    const browserProcesses = tree.map(({ processId, commandLine }) => ({
      processId,
      commandLine,
      kind: classifyProcess(commandLine),
    }));
    for (const browserProcess of browserProcesses) {
      trackedProcesses.set(browserProcess.processId, browserProcess);
    }
    return browserProcesses;
  }

  // A process ID alone could have been reused, so the command line must match too.
  async function listSurvivors(): Promise<BrowserProcess[]> {
    const running = await listProcesses();
    return [...trackedProcesses.values()].filter((tracked) =>
      running.some(
        ({ processId, commandLine }) =>
          processId === tracked.processId && commandLine === tracked.commandLine,
      ),
    );
  }

  // Null means nothing was ever tracked, so there is no finding, rather than a clean stop.
  async function findSurvivors(): Promise<BrowserProcess[] | null> {
    if (trackedProcesses.size === 0) return null;
    const deadline = Date.now() + survivorGraceMilliseconds;
    let survivors = await listSurvivors();
    while (survivors.length > 0 && Date.now() < deadline) {
      await sleep(survivorPollMilliseconds);
      survivors = await listSurvivors();
    }
    return survivors;
  }

  async function browser(...args: string[]): Promise<void> {
    await execFileAsync(process.execPath, [browserCliPath, ...args], { env: environment });
  }

  return {
    appUrl,
    workDirectory,
    browser,
    trackBrowserProcesses,
    findSurvivors,
    // Best effort: leftovers are a finding, so tidying up must never fail the job.
    async cleanUp() {
      try {
        await trackBrowserProcesses();
        await browser("stop").catch(() => undefined);
        await Promise.all(((await findSurvivors()) ?? []).map(({ processId }) => forceStopProcess(processId)));
      } catch (error) {
        console.warn("Browser smoke cleanup failed", error);
      } finally {
        app.kill();
        try {
          rmSync(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch (error) {
          console.warn("Could not remove the browser smoke directory", error);
        }
      }
    },
  };
}
