import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { browserProfileDirectoryOf } from "../evidenceStore.js";
import { readRepoState } from "../repoState.js";

/**
 * The JS entry point of the pinned chrome-devtools-axi, as its manifest names it.
 * PR_EVIDENCE_BROWSER_CLI_PATH lets tests put a fake entry point in its place.
 */
function browserCliPath(): string {
  const testOverride = process.env.PR_EVIDENCE_BROWSER_CLI_PATH;
  if (testOverride !== undefined) {
    return testOverride;
  }
  const manifestPath = createRequire(import.meta.url).resolve("chrome-devtools-axi/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin: Record<string, string> };
  return join(dirname(manifestPath), manifest.bin["chrome-devtools-axi"]!);
}

/**
 * Pins the browser to this repo's dedicated profile and session. The removed variables
 * would otherwise attach it to the developer's own Chrome and their real sessions.
 */
function isolatedEnvironment(repositoryKey: string, headed: boolean): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
  delete environment.CHROME_DEVTOOLS_AXI_BROWSER_URL;
  delete environment.CHROME_DEVTOOLS_AXI_MCP_SERVER_URL;
  environment.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = browserProfileDirectoryOf(repositoryKey);
  environment.CHROME_DEVTOOLS_AXI_SESSION =
    `pr-evidence-${repositoryKey.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 64);
  if (headed) {
    environment.CHROME_DEVTOOLS_AXI_HEADED = "1";
  }
  return environment;
}

/** The exit code a shell would report for a process that ended this way. */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) {
    return code;
  }
  return 128 + (signal === null ? 0 : constants.signals[signal]);
}

export interface BrowserOptions {
  repositoryPath: string;
  /** Shows the browser window, such as for a manual login. */
  headed: boolean;
  /** Passed to chrome-devtools-axi unchanged. */
  args: string[];
}

/**
 * Runs chrome-devtools-axi with these arguments and resolves to its exit code. Its
 * output is passed straight through, because the agent reads it directly.
 *
 * It runs on this Node without a shell, so that no argument, which can hold text from
 * the app under test, is ever read by one.
 */
export function browser({ repositoryPath, headed, args }: BrowserOptions): Promise<number> {
  const { repositoryKey } = readRepoState(repositoryPath);
  return new Promise((resolveExitCode, reject) => {
    const child = spawn(process.execPath, [browserCliPath(), ...args], {
      env: isolatedEnvironment(repositoryKey, headed),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolveExitCode(exitCodeOf(code, signal)));
  });
}
