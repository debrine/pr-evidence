import { execFileSync } from "node:child_process";
import { findWindowsShell, windowsShellPrerequisite } from "./processControl.js";

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

export function checkBrowserCli(): MissingPrerequisite | null {
  return succeeds("chrome-devtools-axi", ["--version"])
    ? null
    : { name: "chrome-devtools-axi", fix: "Run: npm install -g chrome-devtools-axi" };
}

/** Only Windows, where the start command needs Git for Windows' sh.exe. POSIX always has `sh`. */
function checkWindowsShell(): MissingPrerequisite | null {
  return process.platform !== "win32" || findWindowsShell() !== null ? null : windowsShellPrerequisite;
}

export function findMissingPrerequisites(): MissingPrerequisite[] {
  return [checkGitHubCli(), checkBrowserCli(), checkWindowsShell()].filter((missing) => missing !== null);
}
