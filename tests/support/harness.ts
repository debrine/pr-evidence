import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach } from "vitest";

const cliPath = resolve("dist/cli.js");
const temporaryDirectories: string[] = [];
const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) => new Promise((closed) => server.close(closed)),
    ),
  );
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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

/** A directory of stand-ins for the external CLIs the helper shells out to. */
export function createToolShims(options: { ghToken?: string | null; browserCli?: boolean } = {}): string {
  const directory = createTemporaryDirectory();
  symlinkSync(process.execPath, join(directory, "node"));
  const ghToken = options.ghToken === undefined ? "gho_testtoken" : options.ghToken;
  if (ghToken !== null) {
    writeExecutable(join(directory, "gh"), `#!/bin/sh\nprintf '%s\\n' '${ghToken}'\n`);
  }
  if (options.browserCli !== false) {
    writeExecutable(join(directory, "chrome-devtools-axi"), "#!/bin/sh\nexit 0\n");
  }
  return directory;
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
  const toolShims = options.toolShims ?? createToolShims();
  const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: {
        HOME: options.home,
        PATH: [toolShims, systemPath].join(delimiter),
        PR_EVIDENCE_GITHUB_BASE_URL: "http://127.0.0.1:9",
        ...options.env,
      },
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
