import { join } from "node:path";
import { CliError } from "../errors.js";
import { commentMarker, renderEvidenceComment } from "../evidenceComment.js";
import { findLatestRun, readRunRecord, screenshotDirectoryOf } from "../evidenceStore.js";
import {
  assertSupportedHost,
  GitHubClient,
  readUploadToken,
  uploadsBaseUrl,
  type PullRequest,
} from "../github.js";
import { readRepoState } from "../repoState.js";
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

export async function publish(repositoryPath: string): Promise<Record<string, unknown>> {
  const { repositoryKey } = readRepoState(repositoryPath);
  const runDirectory = findLatestRun(repositoryKey);
  const record = runDirectory === null ? null : readRunRecord(runDirectory);
  if (runDirectory === null || record === null) {
    throw new CliError("no_run", "There is no saved run to publish.");
  }
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

  const uploader = new GitHubAttachmentUploader({
    uploadsBaseUrl: uploadsBaseUrl(repository.host),
    token,
    repositoryId,
    host: repository.host,
  });
  // Everything is uploaded before the comment is touched, so a failed upload leaves the PR as it was.
  const gifUrl = outcome.gifPath === null ? null : await uploader.upload(outcome.gifPath);
  const screenshotUrls = await uploadScreenshots(uploader, runDirectory, outcome.screenshots);

  const headHasMoved = pullRequest.headSha !== record.sha;
  const body = renderEvidenceComment({
    repository,
    record,
    outcome,
    screenshotUrls,
    gifUrl,
    headHasMoved,
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
    warnings: headHasMoved
      ? [`The PR head has moved past the tested commit ${record.sha}.`]
      : [],
  };
}
