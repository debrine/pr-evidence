import { probeUrl, startApp } from "../appRunner.js";
import { configFileName, loadConfig, type Config } from "../config.js";
import { CliError } from "../errors.js";
import {
  appLogPathOf,
  browserProfileDirectoryOf,
  createRun,
  pruneExpiredRuns,
  readRunRecord,
  screenshotDirectoryOf,
  writeRunRecord,
} from "../evidenceStore.js";
import { describeUnsupportedHost } from "../github.js";
import { helperVersion } from "../packageInfo.js";
import { checkBrowserCli, checkGitHubCli } from "../prerequisites.js";
import { readRepoState, type RepoState } from "../repoState.js";
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
  const sessionName = `pr-evidence-${repositoryKey.replace(/[^A-Za-z0-9_-]/g, "-")}`;
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

function collectWarnings(repoState: RepoState, skillVersion: string | undefined): string[] {
  const warnings: string[] = [];
  const hostProblem = repoState.repository && describeUnsupportedHost(repoState.repository.host);
  if (repoState.repository === null) {
    warnings.push("The origin remote is not a GitHub repository, so publishing will fail.");
  } else if (hostProblem) {
    warnings.push(`Publishing will fail. ${hostProblem}`);
  }
  const missingGitHubCli = checkGitHubCli();
  if (missingGitHubCli !== null) {
    warnings.push(`Publishing will fail. ${missingGitHubCli.fix}`);
  }
  if (skillVersion !== undefined && skillVersion !== helperVersion) {
    warnings.push(
      `The skill is version ${skillVersion} but the helper is ${helperVersion}. Run: npx pr-evidence setup`,
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
    warnings: collectWarnings(repoState, options.skillVersion),
  };
}
