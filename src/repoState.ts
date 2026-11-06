import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { CliError } from "./errors.js";

export interface RepositoryIdentity {
  host: string;
  owner: string;
  name: string;
}

export interface RepoState {
  rootPath: string;
  sha: string;
  branch: string | null;
  dirty: boolean;
  repository: RepositoryIdentity | null;
  /** Filesystem-safe name for this repo under the evidence root. */
  repositoryKey: string;
}

function git(repositoryPath: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(repositoryPath: string, ...args: string[]): string | null {
  try {
    return git(repositoryPath, ...args);
  } catch {
    return null;
  }
}

export function parseRemoteUrl(remoteUrl: string): RepositoryIdentity | null {
  const match =
    /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      remoteUrl,
    );
  if (!match) {
    return null;
  }
  const [, host, owner, name] = match;
  return { host: host!.toLowerCase(), owner: owner!, name: name! };
}

export function readRepoState(repositoryPath: string): RepoState {
  const topLevel = tryGit(repositoryPath, "rev-parse", "--show-toplevel");
  const sha = tryGit(repositoryPath, "rev-parse", "--verify", "HEAD");
  if (topLevel === null || sha === null) {
    throw new CliError(
      "not_a_git_repository",
      "Run this from inside a git repository with at least one commit.",
    );
  }
  const remoteUrl = tryGit(repositoryPath, "remote", "get-url", "origin");
  const repository = remoteUrl === null ? null : parseRemoteUrl(remoteUrl);
  return {
    rootPath: topLevel,
    sha,
    branch: tryGit(repositoryPath, "symbolic-ref", "--quiet", "--short", "HEAD"),
    dirty: git(repositoryPath, "status", "--porcelain") !== "",
    repository,
    repositoryKey: repository
      ? `${repository.owner}__${repository.name}`
      : basename(topLevel),
  };
}
