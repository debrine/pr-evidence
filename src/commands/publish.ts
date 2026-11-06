import { join } from "node:path";
import { CliError } from "../errors.js";
import { commentMarker, renderEvidenceComment } from "../evidenceComment.js";
import {
  findLatestRun,
  findRunForCommit,
  screenshotDirectoryOf,
  type Run,
} from "../evidenceStore.js";
import {
  assertSupportedHost,
  GitHubClient,
  readUploadToken,
  uploadsBaseUrl,
  type PullRequest,
} from "../github.js";
import { readRepoState, type RepoState } from "../repoState.js";
import { GitHubAttachmentUploader, type Uploader } from "../uploader.js";

async function requirePullRequest(
  github: GitHubClient,
  branch: string | null,
  runDirectory: string,
): Promise<PullRequest> {
  const pullRequest = branch === null ? null : await github.findOpenPullRequest(branch);
  if (pullRequest === null) {
    throw new CliError(
      "no_pull_request",
      `No open PR for ${branch ?? "this detached commit"}. The evidence is saved; open a PR and run publish again.`,
      { runDirectory },
    );
  }
  return pullRequest;
}

async function uploadScreenshots(
  uploader: Uploader,
  runDirectory: string,
  screenshots: string[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const fileName of screenshots) {
    urls.set(fileName, await uploader.upload(join(screenshotDirectoryOf(runDirectory), fileName)));
  }
  return urls;
}

/** The checked-out commit's finished run, otherwise this checkout's latest run. */
function chooseRun(repoState: RepoState): Run {
  const commitRun = findRunForCommit(repoState.repositoryKey, repoState.sha);
  const run = commitRun?.record.outcome ? commitRun : findLatestRun(repoState);
  if (run === null) {
    throw new CliError("no_run", "There is no saved run to publish.");
  }
  return run;
}

export async function publish(repositoryPath: string): Promise<Record<string, unknown>> {
  const { directory: runDirectory, record } = chooseRun(readRepoState(repositoryPath));
  const { outcome, repository } = record;
  if (outcome === undefined) {
    throw new CliError("run_not_finished", "The latest run has no results. Use finish first.");
  }
  if (repository === null) {
    throw new CliError("no_github_remote", "The origin remote is not a GitHub repository.");
  }
  assertSupportedHost(repository.host);

  const token = readUploadToken(repository.host);
  const github = new GitHubClient(repository, token);
  const { repositoryId, viewerLogin } = await github.readRepositoryAccess();
  const pullRequest = await requirePullRequest(github, record.branch, runDirectory);
  const headDiffers = pullRequest.headSha !== record.sha;
  if (headDiffers && !(await github.hasCommit(record.sha))) {
    throw new CliError(
      "commit_not_on_github",
      `The tested commit ${record.sha} is not on GitHub. The evidence is saved; push the commit and run publish again.`,
      { runDirectory },
    );
  }

  const uploader = new GitHubAttachmentUploader({
    uploadsBaseUrl: uploadsBaseUrl(repository.host),
    token,
    repositoryId,
    host: repository.host,
  });
  // Everything is uploaded before the comment is touched, so a failed upload leaves the PR as it was.
  const gifUrl = outcome.gifPath === null ? null : await uploader.upload(outcome.gifPath);
  const screenshotUrls = await uploadScreenshots(uploader, runDirectory, outcome.screenshots);

  const body = renderEvidenceComment({
    repository,
    record,
    outcome,
    screenshotUrls,
    gifUrl,
    headDiffers,
  });
  // Author is checked as well as the marker: anyone can post the marker, and
  // adopting their comment would leave them able to edit the evidence.
  const existingComment = await github.findComment(
    pullRequest.number,
    (comment) => comment.user?.login === viewerLogin && comment.body.startsWith(commentMarker),
  );
  const commentUrl = existingComment
    ? await github.updateComment(existingComment.id, body)
    : await github.createComment(pullRequest.number, body);

  return {
    pullRequest: { number: pullRequest.number, url: pullRequest.url },
    commentUrl,
    warnings: headDiffers ? [`The PR head differs from the tested commit ${record.sha}.`] : [],
  };
}
