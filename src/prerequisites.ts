import { execFileSync } from "node:child_process";

export interface MissingPrerequisite {
  name: string;
  fix: string;
}

function succeeds(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function checkGitHubCli(): MissingPrerequisite | null {
  return succeeds("gh", ["auth", "token"])
    ? null
    : {
        name: "gh",
        fix: "Install the GitHub CLI from https://cli.github.com and run: gh auth login",
      };
}

export function findMissingPrerequisites(): MissingPrerequisite[] {
  return [checkGitHubCli()].filter((missing) => missing !== null);
}
