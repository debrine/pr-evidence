import { execFileSync } from "node:child_process";
import { CliError } from "./errors.js";
import type { RepositoryIdentity } from "./repoState.js";

export interface PullRequest {
  number: number;
  url: string;
  headSha: string;
}

export interface RepositoryAccess {
  repositoryId: number;
  viewerLogin: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string } | null;
}

const allowedTokenPrefixes = ["gho_", "ghp_", "github_pat_"];
const uploadPermissions = ["ADMIN", "MAINTAIN", "WRITE"];
const commentsPerPage = 100;
const requestTimeoutMilliseconds = 30_000;
const unknownCommitStatus = 422;

export function assertSupportedHost(host: string): void {
  if (host !== "github.com" && !host.endsWith(".ghe.com")) {
    throw new CliError(
      "unsupported_host",
      `${host} is not supported: uploads work on github.com and *.ghe.com, not GitHub Enterprise Server or other hosts.`,
    );
  }
}

function subdomainUrl(subdomain: string, host: string): string {
  return process.env.PR_EVIDENCE_GITHUB_BASE_URL ?? `https://${subdomain}.${host}`;
}

export function uploadsBaseUrl(host: string): string {
  return subdomainUrl("uploads", host);
}

/** The token from `gh`, checked against the classes the upload endpoint accepts. */
export function readUploadToken(host: string): string {
  let token: string;
  try {
    token = execFileSync("gh", ["auth", "token", "--hostname", host], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new CliError(
      "github_auth_missing",
      `Could not get a token from gh for ${host}. Install gh and run: gh auth login --hostname ${host}`,
    );
  }
  if (!allowedTokenPrefixes.some((prefix) => token.startsWith(prefix))) {
    throw new CliError(
      "token_refused",
      "GitHub only accepts uploads from OAuth and personal access tokens, not GitHub App or Actions tokens. Log in with gh auth login.",
    );
  }
  return token;
}

export class GitHubClient {
  constructor(
    private readonly repository: RepositoryIdentity,
    private readonly token: string,
  ) {}

  private async request<ResponseBody>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ResponseBody> {
    const url = `${subdomainUrl("api", this.repository.host)}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
    } catch (cause) {
      throw new CliError("github_request_failed", `${method} ${path} failed: ${String(cause)}`);
    }
    if (!response.ok) {
      throw new CliError("github_request_failed", `${method} ${path} returned ${response.status}.`, {
        status: response.status,
      });
    }
    return (await response.json()) as ResponseBody;
  }

  private get repositoryPath(): string {
    return `/repos/${this.repository.owner}/${this.repository.name}`;
  }

  /** Confirms the viewer may upload, and returns what the upload needs. */
  async readRepositoryAccess(): Promise<RepositoryAccess> {
    const { data } = await this.request<{
      data?: {
        viewer: { login: string };
        repository: { databaseId: number; viewerPermission: string | null } | null;
      };
    }>("POST", "/graphql", {
      query:
        "query($owner:String!,$name:String!){viewer{login} repository(owner:$owner,name:$name){databaseId viewerPermission}}",
      variables: { owner: this.repository.owner, name: this.repository.name },
    });
    if (!data?.repository) {
      throw new CliError(
        "github_request_failed",
        `Could not read ${this.repository.owner}/${this.repository.name} on GitHub.`,
      );
    }
    if (!uploadPermissions.includes(data.repository.viewerPermission ?? "")) {
      throw new CliError(
        "permission_denied",
        "Uploading evidence needs write access to the repository.",
      );
    }
    return { repositoryId: data.repository.databaseId, viewerLogin: data.viewer.login };
  }

  async findOpenPullRequest(branch: string): Promise<PullRequest | null> {
    const head = encodeURIComponent(`${this.repository.owner}:${branch}`);
    const pullRequests = await this.request<
      { number: number; html_url: string; head: { sha: string } }[]
    >("GET", `${this.repositoryPath}/pulls?head=${head}&state=open&per_page=1`);
    const pullRequest = pullRequests[0];
    return pullRequest
      ? { number: pullRequest.number, url: pullRequest.html_url, headSha: pullRequest.head.sha }
      : null;
  }

  async hasCommit(sha: string): Promise<boolean> {
    try {
      await this.request("GET", `${this.repositoryPath}/commits/${sha}`);
      return true;
    } catch (error) {
      if (error instanceof CliError && error.details.status === unknownCommitStatus) {
        return false;
      }
      throw error;
    }
  }

  async findComment(
    pullRequestNumber: number,
    matches: (comment: IssueComment) => boolean,
  ): Promise<IssueComment | null> {
    for (let page = 1; ; page += 1) {
      const comments = await this.request<IssueComment[]>(
        "GET",
        `${this.repositoryPath}/issues/${pullRequestNumber}/comments?per_page=${commentsPerPage}&page=${page}`,
      );
      const match = comments.find(matches);
      if (match) {
        return match;
      }
      if (comments.length < commentsPerPage) {
        return null;
      }
    }
  }

  async createComment(pullRequestNumber: number, body: string): Promise<string> {
    const comment = await this.request<{ html_url: string }>(
      "POST",
      `${this.repositoryPath}/issues/${pullRequestNumber}/comments`,
      { body },
    );
    return comment.html_url;
  }

  async updateComment(commentId: number, body: string): Promise<string> {
    const comment = await this.request<{ html_url: string }>(
      "PATCH",
      `${this.repositoryPath}/issues/comments/${commentId}`,
      { body },
    );
    return comment.html_url;
  }
}
