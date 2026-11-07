import { createHash } from "node:crypto";
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
import { isProcessRunning, type ProcessIdentity } from "./processControl.js";
import { CliError } from "./errors.js";
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
  app?: ProcessIdentity;
  /** Present once the run has been finished. */
  outcome?: RunOutcome;
}

const runFileName = "run.json";
const retentionMilliseconds = 14 * 24 * 60 * 60 * 1000;

export interface Run {
  directory: string;
  record: RunRecord;
}

export function evidenceRoot(): string {
  return join(homedir(), ".pr-evidence");
}

/** One pointer per checkout, so runs in separate worktrees of a repo stay apart. */
function latestRunPointerPath(repositoryKey: string, rootPath: string): string {
  const checkoutId = createHash("sha256").update(rootPath).digest("hex").slice(0, 12);
  return join(evidenceRoot(), repositoryKey, `latest-run-${checkoutId}`);
}

function runDirectoryFor(repositoryKey: string, sha: string): string {
  return join(evidenceRoot(), repositoryKey, sha);
}

/** Kept per repo, so a login for one app is never available to another. */
export function browserProfileDirectoryOf(repositoryKey: string): string {
  return join(evidenceRoot(), repositoryKey, "browser-profile");
}

export function screenshotDirectoryOf(runDirectory: string): string {
  return join(runDirectory, "screenshots");
}

export function writeRunRecord(runDirectory: string, record: RunRecord): void {
  writeFileSync(join(runDirectory, runFileName), `${JSON.stringify(record, null, 2)}\n`);
}

export function assertRunAvailable(repoState: RepoState): void {
  const existing = findRunForCommit(repoState.repositoryKey, repoState.sha);
  if (
    existing !== null &&
    existing.record.rootPath !== repoState.rootPath &&
    existing.record.outcome === undefined
  ) {
    throw new CliError(
      "run_checkout_conflict",
      `Another checkout (${existing.record.rootPath}) has an unfinished run at ${repoState.sha}. Finish that run before starting this commit here.`,
    );
  }
}

/** Starts a fresh run. A rerun of the same commit replaces the earlier evidence. */
export function createRun(repoState: RepoState, url: string): string {
  assertRunAvailable(repoState);
  const record = { ...repoState, url, createdAt: new Date().toISOString() };
  const runDirectory = runDirectoryFor(record.repositoryKey, record.sha);
  rmSync(runDirectory, { recursive: true, force: true });
  mkdirSync(screenshotDirectoryOf(runDirectory), { recursive: true });
  writeRunRecord(runDirectory, record);
  writeFileSync(latestRunPointerPath(record.repositoryKey, record.rootPath), record.sha);
  return runDirectory;
}

export function gifPathOf(runDirectory: string): string {
  return join(runDirectory, "evidence.gif");
}

export function listScreenshots(runDirectory: string): string[] {
  return readdirSync(screenshotDirectoryOf(runDirectory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map((entry) => entry.name)
    .sort();
}

export function appLogPathOf(runDirectory: string): string {
  return join(runDirectory, "app.log");
}

export function findRunForCommit(repositoryKey: string, sha: string): Run | null {
  const directory = runDirectoryFor(repositoryKey, sha);
  const record = readRunRecord(directory);
  return record === null ? null : { directory, record };
}

/** The most recent run from this checkout, if it still exists. */
export function findLatestRun({ repositoryKey, rootPath }: RepoState): Run | null {
  const pointerPath = latestRunPointerPath(repositoryKey, rootPath);
  const run = existsSync(pointerPath)
    ? findRunForCommit(repositoryKey, readFileSync(pointerPath, "utf8").trim())
    : null;
  return run?.record.rootPath === rootPath ? run : null;
}

export function readRunRecord(runDirectory: string): RunRecord | null {
  const path = join(runDirectory, runFileName);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RunRecord) : null;
}

function hasRunningApp(runDirectory: string): boolean {
  try {
    const app = readRunRecord(runDirectory)?.app;
    return app !== undefined && isProcessRunning(app);
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
