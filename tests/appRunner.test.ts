import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
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
  it.each(["exit", "timeout"])(
    "returns a bounded verbose log tail and cleans up after %s",
    async (failure) => {
      const directory = createTemporaryDirectory();
      const pidFile = join(directory, "app.pid");
      const verboseApp = join(directory, "verbose-app.mjs");
      const preload = join(directory, "limit-log-read.mjs");
      const tail = "終".repeat(3996) + "end\n";
      writeFileSync(verboseApp, `
        import { writeFileSync, writeSync } from 'node:fs';
        writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        writeSync(1, Buffer.alloc(1024 * 1024, 'x'));
        writeSync(1, ${JSON.stringify(tail)});
        ${failure === "exit" ? "process.exit(3);" : "setInterval(() => {}, 1000);"}
      `);
      writeFileSync(preload, `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const originalRead = fs.readFileSync;
        fs.readFileSync = function (path, ...args) {
          if (String(path).endsWith('/app.log') && fs.statSync(path).size > 64 * 1024) {
            throw new RangeError('whole log exceeds simulated memory limit');
          }
          return originalRead.call(this, path, ...args);
        };
        syncBuiltinESMExports();
      `);
      const { repository } = await repositoryWithApp(() => `exec ${process.execPath} ${verboseApp}`);
      const home = createHome();
      const result = await runCli(["start"], {
        cwd: repository.path, home,
        env: { NODE_OPTIONS: `--import=${preload}`, PR_EVIDENCE_READY_TIMEOUT_MS: "1000" },
      });
      console.log("bounded log tail CLI", JSON.stringify({ failure, result }));
      const processId = appProcessId(pidFile);
      expect(result.exitCode).toBe(2);
      expect(result.json.error.code).toBe(failure === "exit" ? "app_exited" : "app_not_ready");
      expect(result.json.error.appOutput).toBe(tail);
      expect(isRunning(processId)).toBe(false);
      expect(result.stderr).toBe("");
      expect((await runCli(["stop"], { cwd: repository.path, home })).json.stopped).toBe(false);
    },
  );

  it("probes external and configured apps without newer Node cancellation APIs", async () => {
    const preload = join(createTemporaryDirectory(), "node20-cancellation.mjs");
    writeFileSync(preload, "AbortSignal.any = undefined;\n");
    const env = { NODE_OPTIONS: `--import=${preload}`, PR_EVIDENCE_READY_TIMEOUT_MS: "1000" };
    const home = createHome();
    const pidFile = join(createTemporaryDirectory(), "app.pid");
    const { repository } = await repositoryWithApp(
      (port) => `exec ${process.execPath} ${sampleApp} ${port} ${pidFile}`,
    );
    const externalApp = await startTestServer();
    const external = await runCli(["start", "--url", externalApp.url], { cwd: repository.path, home, env });
    console.log("Node 20 external URL CLI", JSON.stringify(external));
    expect(external.exitCode).toBe(0);
    try {
      const configured = await runCli(["start"], { cwd: repository.path, home, env });
      console.log("Node 20 configured app CLI", JSON.stringify(configured));
      if (existsSync(pidFile)) appProcessId(pidFile);
      expect(configured.exitCode).toBe(0);
      const otherRepository = createRepository();
      writeFileSync(join(otherRepository.path, ".pr-evidence.yml"), `start: exit 3\nreadyUrl: ${externalApp.url}\n`);
      git(otherRepository.path, "add", ".");
      git(otherRepository.path, "commit", "-q", "-m", "add config");
      const occupied = await runCli(["start"], { cwd: otherRepository.path, home: createHome(), env });
      console.log("Node 20 occupied URL CLI", JSON.stringify(occupied));
      expect(occupied.json.error.code).toBe("ready_url_in_use");
    } finally {
      await runCli(["stop"], { cwd: repository.path, home });
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "cleans up owned startup when readiness is interrupted by %s",
    async (signal) => {
      const pidFile = join(createTemporaryDirectory(), "app.pid");
      const { repository } = await repositoryWithApp(
        (port) => `exec ${process.execPath} ${sampleApp} ${port} ${pidFile} 60000`,
      );
      const home = createHome();
      const unrelatedApp = await startTestServer();
      const child = spawn(process.execPath, [resolve("dist/cli.js"), "start"], {
        cwd: repository.path,
        env: { ...process.env, HOME: home, PR_EVIDENCE_READY_TIMEOUT_MS: "10000" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const closed = new Promise((resolveClose, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode, exitSignal) => resolveClose({ exitCode, exitSignal }));
      });
      try {
        await expect.poll(() => existsSync(pidFile)).toBe(true);
        const processId = appProcessId(pidFile);
        child.kill(signal);
        const result = await closed;
        console.log("interrupted startup CLI", JSON.stringify({ signal, result, stdout, stderr }));

        expect(isRunning(processId)).toBe(false);
        expect(JSON.parse(stdout).error.code).toBe("app_interrupted");
        expect(JSON.parse(stdout).error.message).toContain(signal);
        expect(stderr).toBe("");
        const repositoryDirectory = join(home, ".pr-evidence", readdirSync(join(home, ".pr-evidence"))[0]!);
        const runDirectory = join(repositoryDirectory, git(repository.path, "rev-parse", "HEAD"));
        expect(JSON.parse(readFileSync(join(runDirectory, "run.json"), "utf8")).app).toBeUndefined();
        expect((await fetch(unrelatedApp.url)).status).toBe(200);
        expect((await runCli(["stop"], { cwd: repository.path, home })).json.stopped).toBe(false);
      } finally {
        child.kill("SIGKILL");
        await closed;
      }
    },
  );

  it("removes startup signal handlers after readiness succeeds", async () => {
    const directory = createTemporaryDirectory();
    const reportPath = join(directory, "signal-handlers.json");
    const preload = join(directory, "report-handlers.mjs");
    writeFileSync(preload, `
      import { writeFileSync } from 'node:fs';
      process.on('beforeExit', () => writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
        SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM'),
      })));
    `);
    const pidFile = join(directory, "app.pid");
    const { repository } = await repositoryWithApp(
      (port) => `exec ${process.execPath} ${sampleApp} ${port} ${pidFile}`,
    );
    const home = createHome();
    try {
      const result = await runCli(["start"], {
        cwd: repository.path, home, env: { NODE_OPTIONS: `--import=${preload}` },
      });
      appProcessId(pidFile);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual({ SIGINT: 0, SIGTERM: 0 });
    } finally {
      await runCli(["stop"], { cwd: repository.path, home });
    }
  });

  it("reports an asynchronous spawn error as a structured CLI failure", async () => {
    const directory = createTemporaryDirectory();
    const missingShell = join(directory, "missing-shell");
    const preload = join(directory, "fail-spawn.mjs");
    writeFileSync(preload, `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const originalSpawn = childProcess.spawn;
      childProcess.spawn = function (command, ...args) {
        return originalSpawn.call(this, command === 'sh' ? ${JSON.stringify(missingShell)} : command, ...args);
      };
      syncBuiltinESMExports();
    `);
    const { repository } = await repositoryWithApp(() => "echo should not run");
    const home = createHome();

    const result = await runCli(["start"], {
      cwd: repository.path, home, env: { NODE_OPTIONS: `--import=${preload}` },
    });
    console.log("asynchronous spawn failure CLI", JSON.stringify(result));

    expect(result.exitCode).toBe(2);
    expect(result.json.ok).toBe(false);
    expect(result.json.error.code).toBe("app_exited");
    expect(result.json.error.message).toContain("Could not launch the start command");
    expect(result.json.error.message).toContain("ENOENT");
    expect(result.stderr).toBe("");
    const stopped = await runCli(["stop"], { cwd: repository.path, home });
    expect(stopped.json.stopped).toBe(false);
  });

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

  it.each([
    "different hosts", "remote-less repositories", "relative filesystem origins",
    "dot-relative filesystem origins", "https endpoint ports", "http endpoint ports", "ssh endpoint ports",
  ])(
    "isolates ownership and same-commit evidence for %s",
    async (identityCase) => {
      const pidFile = join(createTemporaryDirectory(), "app.pid");
      const { repository } = await repositoryWithApp(
        (port) => `node ${sampleApp} ${port} ${pidFile}`,
      );
      const firstPath = join(createTemporaryDirectory(), "widgets");
      const secondPath = join(createTemporaryDirectory(), "widgets");
      git(repository.path, "clone", "-q", repository.path, firstPath);
      git(repository.path, "clone", "-q", repository.path, secondPath);
      for (const path of [firstPath, secondPath]) {
        git(path, "remote", "remove", "origin");
      }
      if (identityCase === "different hosts") {
        git(firstPath, "remote", "add", "origin", "git@github.com:acme/widgets.git");
        git(secondPath, "remote", "add", "origin", "https://git.example.com/acme/widgets.git");
      }
      const origins: Record<string, [string, string]> = {
        "relative filesystem origins": ["../acme/widgets", "../acme/widgets"],
        "dot-relative filesystem origins": ["./acme/widgets", "./acme/widgets"],
        "https endpoint ports": ["https://git.example.com:8443/acme/widgets.git", "https://git.example.com:9443/acme/widgets.git"],
        "http endpoint ports": ["http://git.example.com:8080/acme/widgets.git", "http://git.example.com:9080/acme/widgets.git"],
        "ssh endpoint ports": ["ssh://git@git.example.com:2222/acme/widgets.git", "ssh://git@git.example.com:2223/acme/widgets.git"],
      };
      const originPair = origins[identityCase];
      if (originPair) {
        git(firstPath, "remote", "add", "origin", originPair[0]);
        git(secondPath, "remote", "add", "origin", originPair[1]);
      }
      const home = createHome();
      const externalApp = await startTestServer();
      const first = await runCli(["start"], { cwd: firstPath, home });
      const processId = appProcessId(pidFile);
      const screenshot = join(first.json.screenshotDirectory, "saved.png");
      writeFileSync(screenshot, "evidence");
      try {
        const second = await runCli(["start", "--url", externalApp.url], { cwd: secondPath, home });
        const stopped = await runCli(["stop"], { cwd: secondPath, home });
        console.log("repository isolation CLI", { first, second, stopped });
        expect(second.exitCode).toBe(0);
        expect(isRunning(processId)).toBe(true);
        expect(existsSync(screenshot)).toBe(true);
        expect(second.json.runDirectory).not.toBe(first.json.runDirectory);
        expect(stopped.json.stopped).toBe(false);
      } finally {
        await runCli(["stop"], { cwd: firstPath, home });
      }
    },
  );

  it.each(["before-probe", "during-probe"])(
    "rejects an exited zero-status launcher %s even if its detached server answers",
    async (mode) => {
      const pidFile = join(createTemporaryDirectory(), "detached.pid");
      const launcher = resolve("tests/support/detachedLauncher.mjs");
      const { repository } = await repositoryWithApp(
        (port) => `node ${launcher} ${mode} ${port} ${pidFile}`,
      );
      const home = createHome();
      const result = await runCli(["start"], {
        cwd: repository.path, home,
        env: { PR_EVIDENCE_READY_TIMEOUT_MS: "1500" },
      });
      const processId = appProcessId(pidFile);
      console.log("foreground-only CLI", JSON.stringify({ mode, result }));
      expect(result.exitCode).toBe(2);
      expect(result.json.error.code).toBe("app_exited");
      expect(result.json.error.message).toContain("foreground");
      expect(isRunning(processId)).toBe(true);
      const stopped = await runCli(["stop"], { cwd: repository.path, home });
      expect(stopped.json.stopped).toBe(false);
    },
  );

  it.each(["exit 0", "exit 3", "kill -TERM $$"])(
    "requires the command to stay in the foreground when it runs %s",
    async (command) => {
      const { repository } = await repositoryWithApp(() => command);
      const result = await runCli(["start"], {
        cwd: repository.path, home: createHome(),
        env: { PR_EVIDENCE_READY_TIMEOUT_MS: "500" },
      });
      console.log("exited command CLI", JSON.stringify({ command, result }));
      expect(result.exitCode).toBe(2);
      expect(result.json.error.code).toBe("app_exited");
      expect(result.json.error.message).toContain("foreground");
    },
  );

  it("cleans up the app if recording ownership fails", async () => {
    const directory = createTemporaryDirectory();
    const pidFile = join(directory, "app.pid");
    const { repository } = await repositoryWithApp(
      (port) => `node ${sampleApp} ${port} ${pidFile} 60000`,
    );
    const preload = join(directory, "fail-ownership.mjs");
    writeFileSync(preload, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalWrite = fs.writeFileSync;
      fs.writeFileSync = function (path, data, ...options) {
        if (String(path).endsWith('/run.json') && JSON.parse(String(data)).app) {
          const deadline = Date.now() + 3000;
          while (!fs.existsSync(${JSON.stringify(pidFile)}) && Date.now() < deadline) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          setTimeout(() => process.exit(2), 1000).unref();
          throw new Error('injected ownership write failure');
        }
        return originalWrite.call(this, path, data, ...options);
      };
      syncBuiltinESMExports();
    `);
    const result = await runCli(["start"], {
      cwd: repository.path,
      home: createHome(),
      env: { NODE_OPTIONS: `--import=${preload}` },
    });
    console.log("ownership write failure CLI", result);
    expect(result.exitCode).toBe(2);
    expect(result.json.error.message).toContain("injected ownership write failure");
    expect(isRunning(appProcessId(pidFile))).toBe(false);
  });

  it("clears ownership after failed startup cleanup", async () => {
    const pidFile = join(createTemporaryDirectory(), "app.pid");
    const { repository } = await repositoryWithApp(
      (port) => `node ${sampleApp} ${port} ${pidFile} 60000`,
    );
    const home = createHome();
    const result = await runCli(["start"], {
      cwd: repository.path, home, env: { PR_EVIDENCE_READY_TIMEOUT_MS: "500" },
    });
    const repositoryDirectory = join(home, ".pr-evidence", readdirSync(join(home, ".pr-evidence"))[0]!);
    const runDirectory = join(repositoryDirectory, git(repository.path, "rev-parse", "HEAD"));
    console.log("failed startup CLI", result);
    expect(result.json.error.code).toBe("app_not_ready");
    expect(isRunning(appProcessId(pidFile))).toBe(false);
    expect(JSON.parse(readFileSync(join(runDirectory, "run.json"), "utf8")).app).toBeUndefined();
  });

  it("prunes expired ownership after the app exits naturally but keeps live apps", async () => {
    const pidFile = join(createTemporaryDirectory(), "app.pid");
    const { repository } = await repositoryWithApp(
      (port) => `node ${sampleApp} ${port} ${pidFile}`,
    );
    const home = createHome();
    const started = await runCli(["start"], { cwd: repository.path, home });
    const processId = appProcessId(pidFile);
    const otherRepository = createRepository({ remoteUrl: "git@github.com:acme/other.git" });
    const externalApp = await startTestServer();
    const expire = () => {
      const timestamp = Date.now() / 1000 - 15 * 86400;
      utimesSync(join(started.json.runDirectory, "run.json"), timestamp, timestamp);
    };
    expire();
    try {
      const whileAlive = await runCli(["start", "--url", externalApp.url], { cwd: otherRepository.path, home });
      expect(whileAlive.exitCode).toBe(0);
      expect(existsSync(started.json.runDirectory)).toBe(true);
      process.kill(processId, "SIGTERM");
      await expect.poll(() => isRunning(processId)).toBe(false);
      const afterExit = await runCli(["start", "--url", externalApp.url], { cwd: otherRepository.path, home });
      console.log("prune exited app CLI", { whileAlive, afterExit });
      expect(afterExit.exitCode).toBe(0);
      expect(existsSync(started.json.runDirectory)).toBe(false);
    } finally {
      await runCli(["stop"], { cwd: repository.path, home });
    }
  });

  it("reports when there is no run to stop", async () => {
    const repository = createRepository();

    const result = await runCli(["stop"], { cwd: repository.path, home: createHome() });

    expect(result.exitCode).toBe(0);
    expect(result.json.stopped).toBe(false);
  });
});
