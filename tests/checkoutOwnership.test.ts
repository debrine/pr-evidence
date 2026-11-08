import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { writeResults } from "./support/fixtures.js";
import {
  createHome, createRepository, createTemporaryDirectory, git, runCli, startTestServer,
} from "./support/harness.js";

function secondCheckout(repositoryPath: string): string {
  const checkout = join(createTemporaryDirectory(), "checkout");
  git(repositoryPath, "worktree", "add", "-q", "--detach", checkout);
  return checkout;
}

const criteria = { criteria: [{ description: "It works", result: "pass" }] };

describe("checkout ownership", () => {
  it.each(["external", "configured"])("refuses a same-commit %s start before changing evidence", async (mode) => {
    const repository = createRepository();
    const app = await startTestServer();
    writeFileSync(join(repository.path, ".pr-evidence.yml"), `start: node missing.mjs\nreadyUrl: ${app.url}\n`);
    git(repository.path, "add", ".");
    git(repository.path, "commit", "-qm", "configure app");
    const checkout = secondCheckout(repository.path);
    const home = createHome();
    const first = await runCli(["start", "--url", app.url], { cwd: repository.path, home });
    expect(first.exitCode).toBe(0);
    const recordPath = join(first.json.runDirectory, "run.json");
    const record = readFileSync(recordPath, "utf8");
    const screenshot = join(first.json.screenshotDirectory, "001.png");
    writeFileSync(screenshot, "preserve evidence");
    const refused = await runCli(mode === "external" ? ["start", "--url", app.url] : ["start"], { cwd: checkout, home });
    expect(refused.exitCode).toBe(2);
    expect(refused.json.error.code).toBe("run_checkout_conflict");
    expect(refused.json.error.message).toContain("unfinished run");
    expect(readFileSync(recordPath, "utf8")).toBe(record);
    expect(readFileSync(screenshot, "utf8")).toBe("preserve evidence");
    expect((await runCli(["stop"], { cwd: checkout, home })).json.stopped).toBe(false);
  });

  it.each(["stop", "finish"])("ignores a replaced run through a stale checkout pointer during %s", async (command) => {
    const repository = createRepository();
    const externalApp = await startTestServer();
    const pidFile = join(createTemporaryDirectory(), "app.pid");
    const listener = createServer();
    await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((closed) => listener.close(() => closed()));
    writeFileSync(join(repository.path, ".pr-evidence.yml"),
      `start: node '${resolve("tests/support/app.mjs")}' ${port} '${pidFile}'\nreadyUrl: http://127.0.0.1:${port}/\n`);
    git(repository.path, "add", ".");
    git(repository.path, "commit", "-qm", "configure app");
    const home = createHome();
    const firstContext = { cwd: repository.path, home };
    const results = writeResults(createTemporaryDirectory(), criteria);
    const first = await runCli(["start", "--url", externalApp.url], firstContext);
    expect(first.exitCode).toBe(0);
    expect((await runCli(["finish", "--results", results], firstContext)).exitCode).toBe(0);
    const staleScreenshot = join(first.json.screenshotDirectory, "001-old.png");
    writeFileSync(staleScreenshot, "old evidence");
    const checkout = secondCheckout(repository.path);
    const secondContext = { cwd: checkout, home };
    const second = await runCli(["start"], secondContext);
    expect(second.exitCode).toBe(0);
    expect(second.json.runDirectory).toBe(first.json.runDirectory);
    try {
      expect(existsSync(staleScreenshot)).toBe(false);
      const recordPath = join(second.json.runDirectory, "run.json");
      const record = readFileSync(recordPath, "utf8");
      const ignored = await runCli(command === "stop" ? ["stop"] : ["finish", "--results", results], firstContext);
      if (command === "stop") {
        expect(ignored.exitCode).toBe(0);
        expect(ignored.json.stopped).toBe(false);
      } else {
        expect(ignored.exitCode).toBe(2);
        expect(ignored.json.error.code).toBe("no_run");
      }
      expect(readFileSync(recordPath, "utf8")).toBe(record);
      expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true);
      expect((await runCli(["finish", "--results", results], secondContext)).exitCode).toBe(0);
      expect(existsSync(recordPath)).toBe(true);
      expect(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)).toBe(false);
    } finally {
      await runCli(["stop"], secondContext);
    }
  });
});
