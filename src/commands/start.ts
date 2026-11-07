import { probeUrl, startApp } from "../appRunner.js";
import { configFileName, loadConfig, type Config } from "../config.js";
import { CliError } from "../errors.js";
import {
  appLogPathOf,
  assertRunAvailable,
  browserProfileDirectoryOf,
  createRun,
  pruneExpiredRuns,
  readRunRecord,
  screenshotDirectoryOf,
  writeRunRecord,
} from "../evidenceStore.js";
import { describeUnsupportedHost, GitHubClient, readUploadToken } from "../github.js";
import { helperVersion } from "../packageInfo.js";
import { checkBrowserCli, checkGitHubCli } from "../prerequisites.js";
import { readRepoState, type RepoState, type RepositoryIdentity } from "../repoState.js";
import { describeSetupCommand, findNewerHelperVersion } from "../updateCheck.js";
import { stopLatestRunApp } from "./stop.js";

export interface StartOptions {
  repositoryPath: string;
  allowDirty: boolean;
  url?: string;
  skillVersion?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Pins the browser to a dedicated profile. The unset variables would otherwise
 * attach it to the developer's own Chrome and their real sessions.
 */
function describeBrowser(repositoryKey: string) {
  const profileDirectory = browserProfileDirectoryOf(repositoryKey);
  const sessionName = `pr-evidence-${repositoryKey.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 64);
  return {
    profileDirectory,
    commandPrefix: [
      "env",
      "-u CHROME_DEVTOOLS_AXI_AUTO_CONNECT",
      "-u CHROME_DEVTOOLS_AXI_BROWSER_URL",
      "-u CHROME_DEVTOOLS_AXI_MCP_SERVER_URL",
      `CHROME_DEVTOOLS_AXI_USER_DATA_DIR=${shellQuote(profileDirectory)}`,
      `CHROME_DEVTOOLS_AXI_SESSION=${shellQuote(sessionName)}`,
    ].join(" "),
  };
}

/** Why this commit may not be what the open PR shows, or null when nothing suggests that. */
async function describePullRequestHeadProblem(
  repository: RepositoryIdentity,
  branch: string | null,
  sha: string,
): Promise<string | null> {
  if (branch === null) {
    return null;
  }
  try {
    const github = new GitHubClient(repository, readUploadToken(repository.host));
    const pullRequest = await github.findOpenPullRequest(branch);
    return pullRequest === null || pullRequest.headSha === sha
      ? null
      : `The commit under test ${sha} is not the head of PR #${pullRequest.number} (${pullRequest.headSha}). Push it, or check out the PR head, before testing. Publishing refuses a commit that is not on GitHub, and posts any other commit with a warning.`;
  } catch (error) {
    return `Could not compare this commit with the open PR. ${(error as Error).message}`;
  }
}

async function collectWarnings(
  repoState: RepoState,
  skillVersion: string | undefined,
  newerHelperVersionLookup: Promise<string | null>,
): Promise<string[]> {
  const warnings: string[] = [];
  const { repository, branch, sha } = repoState;
  const hostProblem = repository && describeUnsupportedHost(repository.host);
  if (repository === null) {
    warnings.push("The origin remote is not a GitHub repository, so publishing will fail.");
  } else if (hostProblem) {
    warnings.push(`Publishing will fail. ${hostProblem}`);
  }
  const missingGitHubCli = checkGitHubCli();
  if (missingGitHubCli !== null) {
    warnings.push(`Publishing will fail. ${missingGitHubCli.fix}`);
  }
  if (repository !== null && hostProblem === null && missingGitHubCli === null) {
    const headProblem = await describePullRequestHeadProblem(repository, branch, sha);
    if (headProblem !== null) {
      warnings.push(headProblem);
    }
  }
  if (skillVersion !== undefined && skillVersion !== helperVersion) {
    warnings.push(
      `The skill is version ${skillVersion} but the helper is ${helperVersion}. Run: ${describeSetupCommand(helperVersion)}`,
    );
  }
  const newerVersion = await newerHelperVersionLookup;
  if (newerVersion !== null) {
    warnings.push(
      `pr-evidence ${newerVersion} is available, and this is ${helperVersion}. Run: ${describeSetupCommand(newerVersion)}`,
    );
  }
  return warnings;
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
  const runDirectory = createRun(repoState, config.readyUrl);
  const record = readRunRecord(runDirectory)!;
  await startApp(config.start, {
    cwd: repoState.rootPath,
    logPath: appLogPathOf(runDirectory),
    readyUrl: config.readyUrl,
    onStarted: (app) => writeRunRecord(runDirectory, { ...record, app }),
    onStopped: () => writeRunRecord(runDirectory, record),
  });
  return runDirectory;
}

async function useRunningApp(url: string, repoState: RepoState): Promise<string> {
  if ((await probeUrl(url)) === null) {
    throw new CliError("url_unreachable", `Could not reach ${url}.`);
  }
  return createRun(repoState, url);
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

  const missingBrowserCli = checkBrowserCli();
  if (missingBrowserCli !== null) {
    throw new CliError(
      "missing_prerequisite",
      `${missingBrowserCli.name} is required. ${missingBrowserCli.fix}`,
    );
  }

  // Looked up while the app starts, so that a slow registry adds as little as possible to the run.
  const lookupCancellation = new AbortController();
  const newerHelperVersionLookup = findNewerHelperVersion(lookupCancellation.signal);
  try {
    return await startRun(options, config, repoState, newerHelperVersionLookup);
  } catch (error) {
    // An open request would keep the process alive until the lookup times out.
    lookupCancellation.abort();
    throw error;
  }
}

async function startRun(
  options: StartOptions,
  config: Config | null,
  repoState: RepoState,
  newerHelperVersionLookup: Promise<string | null>,
): Promise<Record<string, unknown>> {
  assertRunAvailable(repoState);
  await stopLatestRunApp(repoState);
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
    browser: describeBrowser(repoState.repositoryKey),
    warnings: await collectWarnings(repoState, options.skillVersion, newerHelperVersionLookup),
  };
}
