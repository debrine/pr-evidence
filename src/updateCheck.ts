import { helperVersion } from "./packageInfo.js";

/** Long enough for a slow registry, short enough that a stalled proxy does not hold up a run. */
const lookupTimeoutMilliseconds = 2_000;

/** PR_EVIDENCE_REGISTRY_URL lets tests point the update check at a local fake. */
function registryUrl(): string {
  return process.env.PR_EVIDENCE_REGISTRY_URL ?? "https://registry.npmjs.org";
}

/** The command that installs a version of the helper and its skill, in the form this platform runs. */
export function describeSetupCommand(version: string): string {
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  return `${npxCommand} pr-evidence@${version} setup`;
}

interface ParsedVersion {
  release: number[];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) return null;
  return {
    release: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftIsNumber = /^\d+$/.test(left);
  const rightIsNumber = /^\d+$/.test(right);
  if (leftIsNumber && rightIsNumber) return Number(left) - Number(right);
  // Semantic versioning ranks numeric identifiers below alphanumeric ones.
  if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semantic version precedence: below zero when left is older, above zero when it is newer. */
function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index++) {
    const difference = left.release[index]! - right.release[index]!;
    if (difference !== 0) return difference;
  }
  // A prerelease comes before the release it leads up to.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const difference = compareIdentifiers(left.prerelease[index]!, right.prerelease[index]!);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isNewerThanThisHelper(publishedVersion: unknown): publishedVersion is string {
  if (typeof publishedVersion !== "string") return false;
  const published = parseVersion(publishedVersion);
  const installed = parseVersion(helperVersion);
  return published !== null && installed !== null && compareVersions(published, installed) > 0;
}

/** The latest published version when it is newer than this one, otherwise null, including when the registry did not say. */
export async function findNewerHelperVersion(cancellation: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(`${registryUrl()}/pr-evidence`, {
      signal: AbortSignal.any([cancellation, AbortSignal.timeout(lookupTimeoutMilliseconds)]),
    });
    if (!response.ok) return null;
    const packageDocument = (await response.json()) as { "dist-tags"?: { latest?: unknown } };
    const latestVersion = packageDocument["dist-tags"]?.latest;
    return isNewerThanThisHelper(latestVersion) ? latestVersion : null;
  } catch {
    // Being offline or behind a proxy must never get in the way of a run.
    return null;
  }
}
