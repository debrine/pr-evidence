import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterAll, afterEach } from "vitest";

const cliPath = resolve("dist/cli.js");
const isWindows = process.platform === "win32";
const windowsToolPreloadName = "tool-stand-ins.cjs";
const temporaryDirectories: string[] = [];
const openServers: Server[] = [];
let windowsNodeCopy: { directory: string; path: string } | undefined;

function removeDirectory(directory: string): void {
  // Windows can hold a file open briefly after the process using it has exited.
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) => new Promise((closed) => server.close(closed)),
    ),
  );
  temporaryDirectories.splice(0).forEach(removeDirectory);
});

afterAll(() => {
  if (windowsNodeCopy) removeDirectory(windowsNodeCopy.directory);
  windowsNodeCopy = undefined;
});

export function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pr-evidence-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

export function git(repositoryPath: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repositoryPath, encoding: "utf8" }).trim();
}

export interface TestRepository {
  path: string;
  headSha: string;
}

export function createRepository(
  options: { remoteUrl?: string; branch?: string } = {},
): TestRepository {
  const path = createTemporaryDirectory();
  git(path, "init", "-q", "-b", options.branch ?? "main");
  git(path, "config", "user.email", "test@example.com");
  git(path, "config", "user.name", "Test");
  git(path, "config", "commit.gpgsign", "false");
  git(path, "remote", "add", "origin", options.remoteUrl ?? "git@github.com:acme/widgets.git");
  writeFileSync(join(path, "app.txt"), "hello\n");
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "first commit");
  return { path, headSha: git(path, "rev-parse", "HEAD") };
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** One copy per test file, so that each set of stand-ins can hard link it cheaply. */
function sharedWindowsNodeCopy(): string {
  if (!windowsNodeCopy) {
    const directory = mkdtempSync(join(tmpdir(), "pr-evidence-test-node-"));
    windowsNodeCopy = { directory, path: join(directory, "node.exe") };
    copyFileSync(process.execPath, windowsNodeCopy.path);
  }
  return windowsNodeCopy.path;
}

/**
 * Windows only runs real executables without a shell, so each stand-in is a copy of
 * node.exe under the tool's name. A preload script recognises that name, prints the
 * tool's output and exits before Node reads the tool's arguments as a script path.
 */
function writeWindowsToolShims(directory: string, toolOutputs: Record<string, string>): void {
  const nodeCopy = sharedWindowsNodeCopy();
  for (const toolName of ["node", ...Object.keys(toolOutputs)]) {
    linkSync(nodeCopy, join(directory, `${toolName}.exe`));
  }
  writeFileSync(
    join(directory, windowsToolPreloadName),
    `const { writeSync } = require("node:fs");
const { parse } = require("node:path");
const toolOutput = ${JSON.stringify(toolOutputs)}[parse(process.execPath).name];
if (toolOutput !== undefined) {
  writeSync(1, toolOutput);
  process.exit(0);
}
`,
  );
}

function writePosixToolShims(directory: string, toolOutputs: Record<string, string>): void {
  writeExecutable(join(directory, "node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  for (const [toolName, toolOutput] of Object.entries(toolOutputs)) {
    writeExecutable(join(directory, toolName), `#!/bin/sh\nprintf '%s' '${toolOutput}'\n`);
  }
}

/** A directory of stand-ins for the external CLIs the helper shells out to. */
export function createToolShims(options: { ghToken?: string | null; browserCli?: boolean } = {}): string {
  const directory = createTemporaryDirectory();
  const ghToken = options.ghToken === undefined ? "gho_testtoken" : options.ghToken;
  const toolOutputs: Record<string, string> = {};
  if (ghToken !== null) toolOutputs.gh = `${ghToken}\n`;
  if (options.browserCli !== false) toolOutputs["chrome-devtools-axi"] = "";
  (isWindows ? writeWindowsToolShims : writePosixToolShims)(directory, toolOutputs);
  return directory;
}

function systemPath(): string {
  if (!isWindows) return "/usr/bin:/bin:/usr/sbin:/sbin";
  const systemRoot = process.env.SystemRoot!;
  const gitExecutable = execFileSync("where.exe", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0]!;
  return [join(systemRoot, "System32"), systemRoot, dirname(gitExecutable)].join(delimiter);
}

/** What a Windows process needs from its environment, plus the preload for the stand-ins. */
function windowsEnvironment(toolShims: string, nodeOptions = ""): Record<string, string> {
  // NODE_OPTIONS treats a backslash as an escape, even inside quotes.
  const preloadPath = join(toolShims, windowsToolPreloadName).replaceAll("\\", "/");
  return {
    SystemRoot: process.env.SystemRoot!,
    TEMP: tmpdir(),
    TMP: tmpdir(),
    NODE_OPTIONS: `--require "${preloadPath}" ${nodeOptions}`.trim(),
  };
}

/** The whole environment of a CLI run, so that nothing leaks in from the developer's machine. */
export function cliEnvironment(
  options: Pick<CliOptions, "home" | "env" | "toolShims">,
): Record<string, string> {
  const toolShims = options.toolShims ?? createToolShims();
  return {
    // Node reads the home directory from HOME on POSIX and USERPROFILE on Windows.
    HOME: options.home,
    USERPROFILE: options.home,
    PATH: [toolShims, systemPath()].join(delimiter),
    PR_EVIDENCE_GITHUB_BASE_URL: "http://127.0.0.1:9",
    ...options.env,
    ...(isWindows ? windowsEnvironment(toolShims, options.env?.NODE_OPTIONS) : {}),
  };
}

export interface CliResult {
  exitCode: number;
  stderr: string;
  // Parsed stdout. Every command prints one JSON document.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export interface CliOptions {
  cwd: string;
  home: string;
  env?: Record<string, string>;
  toolShims?: string;
}

/** Runs the built CLI as a black box, in the way a skill would. */
export function runCli(args: string[], options: CliOptions): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: cliEnvironment(options),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      let json: unknown = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        reject(new Error(`stdout was not JSON (exit ${exitCode}): ${stdout}\n${stderr}`));
        return;
      }
      resolvePromise({ exitCode: exitCode ?? -1, stderr, json });
    });
  });
}

export function createHome(): string {
  const home = createTemporaryDirectory();
  mkdirSync(join(home, ".pr-evidence"), { recursive: true });
  return home;
}

/** A real HTTP server standing in for an app that is already running. */
export async function startTestServer(): Promise<{ url: string }> {
  const server = createServer((_request, response) => response.end("ok"));
  openServers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}
