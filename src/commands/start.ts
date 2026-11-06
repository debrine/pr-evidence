import { probeUrl, startApp } from "../appRunner.js";
import { configFileName, loadConfig, type Config } from "../config.js";
import { CliError } from "../errors.js";
import {
  appLogPathOf,
  createRun,
  pruneExpiredRuns,
  readRunRecord,
  screenshotDirectoryOf,
  writeRunRecord,
} from "../evidenceStore.js";
import { readRepoState, type RepoState } from "../repoState.js";
import { stopLatestRunApp } from "./stop.js";

export interface StartOptions {
  repositoryPath: string;
  allowDirty: boolean;
  url?: string;
}

async function startConfiguredApp(
  config: Config,
  repoState: RepoState,
): Promise<string> {
  if ((await probeUrl(config.readyUrl)) !== null) {
    throw new CliError(
      "ready_url_in_use",
      `Something is already answering on ${config.readyUrl}, and this tool did not start it. Stop it, or pass --url to test it.`,
    );
  }
  const runDirectory = createRun({
    ...repoState,
    url: config.readyUrl,
    createdAt: new Date().toISOString(),
  });
  await startApp(config.start, {
    cwd: repoState.rootPath,
    logPath: appLogPathOf(runDirectory),
    readyUrl: config.readyUrl,
    onStarted: (app) => writeRunRecord(runDirectory, { ...readRunRecord(runDirectory)!, app }),
  });
  return runDirectory;
}

async function useRunningApp(url: string, repoState: RepoState): Promise<string> {
  if ((await probeUrl(url)) === null) {
    throw new CliError("url_unreachable", `Could not reach ${url}.`);
  }
  return createRun({ ...repoState, url, createdAt: new Date().toISOString() });
}

export async function start(options: StartOptions): Promise<Record<string, unknown>> {
  const repoState = readRepoState(options.repositoryPath);
  if (repoState.dirty && !options.allowDirty) {
    throw new CliError(
      "dirty_working_tree",
      "The working tree has uncommitted changes, so evidence could not claim to show a commit. Commit them, or pass --allow-dirty for a quick check.",
    );
  }
  const config = loadConfig(repoState.rootPath);
  if (options.url === undefined && config === null) {
    throw new CliError(
      "config_missing",
      `No ${configFileName} in this repo. Add one with start and readyUrl, or pass --url.`,
    );
  }

  await stopLatestRunApp(repoState.repositoryKey);
  pruneExpiredRuns();
  const runDirectory =
    options.url === undefined
      ? await startConfiguredApp(config!, repoState)
      : await useRunningApp(options.url, repoState);

  return {
    sha: repoState.sha,
    branch: repoState.branch,
    dirty: repoState.dirty,
    url: readRunRecord(runDirectory)!.url,
    runDirectory,
    screenshotDirectory: screenshotDirectoryOf(runDirectory),
    login: config?.login ?? null,
    ticketFolder: config?.ticketFolder ?? null,
  };
}
