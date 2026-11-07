import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHome, createRepository, runCli, startTestServer } from "./support/harness.js";

const dayInSeconds = 24 * 60 * 60;

function seedRun(home: string, repositoryKey: string, sha: string, ageInDays: number): string {
  const runDirectory = join(home, ".pr-evidence", repositoryKey, sha);
  mkdirSync(runDirectory, { recursive: true });
  const runFile = join(runDirectory, "run.json");
  writeFileSync(runFile, "{}");
  const timestamp = Date.now() / 1000 - ageInDays * dayInSeconds;
  utimesSync(runFile, timestamp, timestamp);
  return runDirectory;
}

describe("evidence store", () => {
  it("prunes runs older than 14 days across repos and keeps newer ones", async () => {
    const repository = createRepository();
    const app = await startTestServer();
    const home = createHome();
    const expiredRun = seedRun(home, "acme__widgets", "a".repeat(40), 15);
    const expiredRunOfOtherRepo = seedRun(home, "acme__gadgets", "b".repeat(40), 30);
    const recentRun = seedRun(home, "acme__widgets", "c".repeat(40), 13);

    const result = await runCli(["start", "--url", app.url], { cwd: repository.path, home });

    expect(result.exitCode).toBe(0);
    expect(existsSync(expiredRun)).toBe(false);
    expect(existsSync(expiredRunOfOtherRepo)).toBe(false);
    expect(existsSync(recentRun)).toBe(true);
  });

  it("does not prune anything that is not a run, such as a saved browser profile", async () => {
    const repository = createRepository();
    const app = await startTestServer();
    const home = createHome();
    const profile = join(home, ".pr-evidence", "acme__widgets", "browser-profile");
    mkdirSync(profile, { recursive: true });
    const timestamp = Date.now() / 1000 - 60 * dayInSeconds;
    utimesSync(profile, timestamp, timestamp);

    await runCli(["start", "--url", app.url], { cwd: repository.path, home });

    expect(existsSync(profile)).toBe(true);
  });

  it("does not prune the installed helper, however old it is", async () => {
    const repository = createRepository();
    const app = await startTestServer();
    const home = createHome();
    const installedHelper = join(home, ".pr-evidence", "app", "0.0.1");
    const helperFile = join(installedHelper, "node_modules", "pr-evidence", "dist", "cli.js");
    mkdirSync(dirname(helperFile), { recursive: true });
    writeFileSync(helperFile, "");
    const timestamp = Date.now() / 1000 - 60 * dayInSeconds;
    utimesSync(helperFile, timestamp, timestamp);
    utimesSync(installedHelper, timestamp, timestamp);

    const result = await runCli(["start", "--url", app.url], { cwd: repository.path, home });

    expect(result.exitCode).toBe(0);
    expect(existsSync(helperFile)).toBe(true);
  });

  it("replaces earlier evidence when the same commit is run again", async () => {
    const repository = createRepository();
    const app = await startTestServer();
    const home = createHome();
    const first = await runCli(["start", "--url", app.url], { cwd: repository.path, home });
    const staleScreenshot = join(first.json.screenshotDirectory, "001-old.png");
    writeFileSync(staleScreenshot, "old");

    await runCli(["start", "--url", app.url], { cwd: repository.path, home });

    expect(existsSync(staleScreenshot)).toBe(false);
  });
});
