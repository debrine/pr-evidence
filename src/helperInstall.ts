import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { helperVersion } from "./packageInfo.js";

/** Written last, because an interrupted `npm install` can leave the CLI without its dependencies. */
const installCompleteMarker = ".install-complete";

function appDirectory(): string {
  return join(homedir(), ".pr-evidence", "app");
}

function runNpmInstall(versionDirectory: string, packageSource: string): void {
  mkdirSync(versionDirectory, { recursive: true });
  // Without a manifest here, npm walks up and installs into any project above, such as the home directory.
  writeFileSync(join(versionDirectory, "package.json"), '{ "private": true }\n');
  try {
    // Through a shell, because on Windows npm is a .cmd file, which Node cannot run without one.
    execSync(
      `npm install "${packageSource}" --save-exact --no-audit --no-fund --no-update-notifier --loglevel=error`,
      { cwd: versionDirectory, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true },
    );
  } catch (error) {
    throw new CliError(
      "install_failed",
      `Could not install ${packageSource} with npm. Check your registry and proxy settings: ` +
        "`npm config get registry` shows the registry in use, and `npm config set proxy <url>` sets a proxy.",
      { npmOutput: String((error as { stderr?: string }).stderr ?? error).trim() },
    );
  }
  writeFileSync(join(versionDirectory, installCompleteMarker), "");
}

/** Installs this exact version, if it is not there yet, and returns the path of its CLI. */
export function installHelper(): string {
  const versionDirectory = join(appDirectory(), helperVersion);
  // For trying an unreleased build, whose version number says nothing about its contents.
  const unreleasedBuild = process.env.PR_EVIDENCE_INSTALL_SOURCE;
  if (unreleasedBuild !== undefined || !existsSync(join(versionDirectory, installCompleteMarker))) {
    runNpmInstall(versionDirectory, unreleasedBuild ?? `pr-evidence@${helperVersion}`);
  }
  return join(versionDirectory, "node_modules", "pr-evidence", "dist", "cli.js");
}

/** Best effort: on Windows a running browser bridge can hold an old version's files open. */
export function removeOldHelperVersions(): void {
  const oldVersions = readdirSync(appDirectory()).filter((version) => version !== helperVersion);
  for (const version of oldVersions) {
    try {
      rmSync(join(appDirectory(), version), { recursive: true, force: true });
    } catch {
      process.stderr.write(`Could not remove old helper version ${version}. The next setup tries again.\n`);
    }
  }
}
