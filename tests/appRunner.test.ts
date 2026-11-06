import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHome,
  createRepository,
  createTemporaryDirectory,
  git,
  runCli,
  startTestServer,
} from "./support/harness.js";

const sampleApp = resolve("tests/support/app.mjs");
const startedProcessIds: number[] = [];

afterEach(() => {
  for (const processId of startedProcessIds.splice(0)) {
    if (isRunning(processId)) {
      process.kill(processId, "SIGKILL");
    }
  }
});

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  await new Promise((closed) => server.close(closed));
  return (address as { port: number }).port;
}

async function repositoryWithApp(startCommand: (port: number) => string) {
  const port = await freePort();
  const repository = createRepository();
  writeFileSync(
    join(repository.path, ".pr-evidence.yml"),
    `start: ${JSON.stringify(startCommand(port))}\nreadyUrl: http://127.0.0.1:${port}/\n`,
  );
  git(repository.path, "add", ".");
  git(repository.path, "commit", "-q", "-m", "add config");
  return { repository, port };
}

function appProcessId(pidFile: string): number {
  const processId = Number(readFileSync(pidFile, "utf8"));
  startedProcessIds.push(processId);
  return processId;
}

describe("app runner", () => {
  it("starts the configured app, waits until it is ready, and stop stops it", async () => {
    const pidFile = join(createTemporaryDirectory(), "app.pid");
    const { repository, port } = await repositoryWithApp(
      (appPort) => `node ${sampleApp} ${appPort} ${pidFile} 300`,
    );
    const home = createHome();

    const started = await runCli(["start"], { cwd: repository.path, home });

    expect(started.exitCode).toBe(0);
    expect(started.json.url).toBe(`http://127.0.0.1:${port}/`);
    expect((await fetch(started.json.url)).status).toBe(200);
    const processId = appProcessId(pidFile);

    const stopped = await runCli(["stop"], { cwd: repository.path, home });

    expect(stopped.exitCode).toBe(0);
    expect(stopped.json.stopped).toBe(true);
    expect(isRunning(processId)).toBe(false);
  });

  it("stops a whole process tree, not only the shell that launched it", async () => {
    const pidFile = join(createTemporaryDirectory(), "app.pid");
    const { repository } = await repositoryWithApp(
      (appPort) => `sh -c 'node ${sampleApp} ${appPort} ${pidFile}; echo done'`,
    );
    const home = createHome();

    await runCli(["start"], { cwd: repository.path, home });
    const processId = appProcessId(pidFile);
    await runCli(["stop"], { cwd: repository.path, home });

    expect(isRunning(processId)).toBe(false);
  });

  it("fails with the app's output when the app exits before it is ready", async () => {
    const { repository } = await repositoryWithApp(() => "echo cannot bind; exit 3");

    const result = await runCli(["start"], { cwd: repository.path, home: createHome() });

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("app_exited");
    expect(result.json.error.appOutput).toContain("cannot bind");
  });

  it("fails with the app's output and leaves nothing running when the ready wait times out", async () => {
    const pidFile = join(createTemporaryDirectory(), "app.pid");
    const { repository } = await repositoryWithApp(
      (appPort) => `node ${sampleApp} ${appPort} ${pidFile} 60000`,
    );

    const result = await runCli(["start"], {
      cwd: repository.path,
      home: createHome(),
      env: { PR_EVIDENCE_READY_TIMEOUT_MS: "500" },
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("app_not_ready");
    expect(result.json.error.appOutput).toContain("sample app booting");
    expect(isRunning(appProcessId(pidFile))).toBe(false);
  });

  it("refuses to start over something already answering on the ready URL", async () => {
    const running = await startTestServer();
    const repository = createRepository();
    const markerFile = join(createTemporaryDirectory(), "started");
    writeFileSync(
      join(repository.path, ".pr-evidence.yml"),
      `start: touch ${markerFile}\nreadyUrl: ${running.url}\n`,
    );
    git(repository.path, "add", ".");
    git(repository.path, "commit", "-q", "-m", "add config");

    const result = await runCli(["start"], { cwd: repository.path, home: createHome() });

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("ready_url_in_use");
    expect(existsSync(markerFile)).toBe(false);
  });

  it("does not stop an app it did not start", async () => {
    const pidFile = join(createTemporaryDirectory(), "app.pid");
    const port = await freePort();
    const ownApp = spawn(process.execPath, [sampleApp, String(port), pidFile], { stdio: "ignore" });
    startedProcessIds.push(ownApp.pid!);
    const url = `http://127.0.0.1:${port}/`;
    await expect.poll(() => fetch(url).then((r) => r.status, () => 0)).toBe(200);
    const repository = createRepository();
    const home = createHome();

    await runCli(["start", "--url", url], { cwd: repository.path, home });
    const stopped = await runCli(["stop"], { cwd: repository.path, home });

    expect(stopped.exitCode).toBe(0);
    expect(stopped.json.stopped).toBe(false);
    expect(isRunning(ownApp.pid!)).toBe(true);
  });

  it("stops an app left over from an earlier run before starting a new one", async () => {
    const pidFile = join(createTemporaryDirectory(), "app.pid");
    const { repository } = await repositoryWithApp(
      (appPort) => `node ${sampleApp} ${appPort} ${pidFile}`,
    );
    const home = createHome();

    const first = await runCli(["start"], { cwd: repository.path, home });
    const firstProcessId = appProcessId(pidFile);
    const second = await runCli(["start"], { cwd: repository.path, home });
    const secondProcessId = appProcessId(pidFile);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(isRunning(firstProcessId)).toBe(false);
    expect(isRunning(secondProcessId)).toBe(true);
    await runCli(["stop"], { cwd: repository.path, home });
  });

  it("reports when there is no run to stop", async () => {
    const repository = createRepository();

    const result = await runCli(["stop"], { cwd: repository.path, home: createHome() });

    expect(result.exitCode).toBe(0);
    expect(result.json.stopped).toBe(false);
  });
});
