import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAppRunning, type AppProcess } from "./appRunner.js";
import type { RepoState } from "./repoState.js";

export interface CriterionResult {
  description: string;
  result: "pass" | "fail";
  /** File name in the run's screenshot directory. */
  screenshot?: string;
  note?: string;
}

export interface RunOutcome {
  result: "pass" | "fail";
  ticket: string | null;
  criteria: CriterionResult[];
  /** Screenshot file names in step order. */
  screenshots: string[];
  gifPath: string | null;
}

export interface RunRecord extends RepoState {
  url: string;
  createdAt: string;
  /** Present only while an app this tool started may still be running. */
  app?: AppProcess;
  /** Present once the run has been finished. */
  outcome?: RunOutcome;
}

const runFileName = "run.json";
const latestRunFileName = "latest-run";
const retentionMilliseconds = 14 * 24 * 60 * 60 * 1000;

function evidenceRoot(): string {
  return join(homedir(), ".pr-evidence");
}

function runDirectoryFor(repositoryKey: string, sha: string): string {
  return join(evidenceRoot(), repositoryKey, sha);
}

export function screenshotDirectoryOf(runDirectory: string): string {
  return join(runDirectory, "screenshots");
}

export function writeRunRecord(runDirectory: string, record: RunRecord): void {
  writeFileSync(join(runDirectory, runFileName), `${JSON.stringify(record, null, 2)}\n`);
}

/** Starts a fresh run. A rerun of the same commit replaces the earlier evidence. */
export function createRun(record: RunRecord): string {
  const runDirectory = runDirectoryFor(record.repositoryKey, record.sha);
  rmSync(runDirectory, { recursive: true, force: true });
  mkdirSync(screenshotDirectoryOf(runDirectory), { recursive: true });
  writeRunRecord(runDirectory, record);
  writeFileSync(join(evidenceRoot(), record.repositoryKey, latestRunFileName), record.sha);
  return runDirectory;
}

export function gifPathOf(runDirectory: string): string {
  return join(runDirectory, "evidence.gif");
}

export function listScreenshots(runDirectory: string): string[] {
  return readdirSync(screenshotDirectoryOf(runDirectory))
    .filter((fileName) => fileName.toLowerCase().endsWith(".png"))
    .sort();
}

export function appLogPathOf(runDirectory: string): string {
  return join(runDirectory, "app.log");
}

/** The directory of the most recent run for this repo, if it still exists. */
export function findLatestRun(repositoryKey: string): string | null {
  const pointerPath = join(evidenceRoot(), repositoryKey, latestRunFileName);
  if (!existsSync(pointerPath)) {
    return null;
  }
  const runDirectory = runDirectoryFor(repositoryKey, readFileSync(pointerPath, "utf8").trim());
  return existsSync(join(runDirectory, runFileName)) ? runDirectory : null;
}

export function readRunRecord(runDirectory: string): RunRecord | null {
  const path = join(runDirectory, runFileName);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RunRecord) : null;
}

function hasRunningApp(runDirectory: string): boolean {
  try {
    const app = readRunRecord(runDirectory)?.app;
    return app !== undefined && isAppRunning(app);
  } catch {
    return false;
  }
}

function subdirectoriesOf(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name));
}

/** Deletes expired runs for every repo. Only directories holding a run file count as runs. */
export function pruneExpiredRuns(): void {
  const oldestKept = Date.now() - retentionMilliseconds;
  if (!existsSync(evidenceRoot())) {
    return;
  }
  for (const repositoryDirectory of subdirectoriesOf(evidenceRoot())) {
    for (const runDirectory of subdirectoriesOf(repositoryDirectory)) {
      const runFile = join(runDirectory, runFileName);
      if (
        existsSync(runFile) &&
        statSync(runFile).mtimeMs < oldestKept &&
        !hasRunningApp(runDirectory)
      ) {
        rmSync(runDirectory, { recursive: true, force: true });
      }
    }
  }
}
