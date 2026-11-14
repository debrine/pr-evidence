import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors.js";
import {
  findLatestRun,
  listScreenshots,
  screenshotDirectoryOf,
  writeRunRecord,
  type CriterionResult,
  type RunOutcome,
} from "../evidenceStore.js";
import { readRepoState } from "../repoState.js";
import { imageSizeProblem } from "../uploader.js";
import { stopLatestRunApp } from "./stop.js";

function invalid(problem: string): CliError {
  return new CliError("results_invalid", `Results file: ${problem}`);
}

function parseScreenshotList(description: string, value: unknown, captured: string[]): string[] {
  if (!Array.isArray(value)) {
    throw invalid(`"${description}" needs "screenshots", a list of file names that may be empty.`);
  }
  for (const [index, fileName] of value.entries()) {
    if (typeof fileName !== "string") {
      throw invalid(`"${description}" has a screenshot that is not a file name: ${JSON.stringify(fileName)}.`);
    }
    if (!captured.includes(fileName)) {
      throw invalid(`"${description}" names screenshot ${fileName}, which was not captured.`);
    }
    if (value.indexOf(fileName) !== index) {
      throw invalid(`"${description}" lists screenshot ${fileName} more than once.`);
    }
  }
  return value;
}

function parseCriterion(value: unknown, captured: string[]): CriterionResult {
  const { description, result, screenshots, note, screenshot } = (value ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof description !== "string" || description.trim() === "") {
    throw invalid('every criterion needs a "description".');
  }
  if (screenshot !== undefined) {
    throw invalid(`"${description}" uses "screenshot", which was replaced. Use screenshots: [...] instead.`);
  }
  if (result !== "pass" && result !== "fail") {
    throw invalid(`"${description}" needs a result of "pass" or "fail".`);
  }
  if (note !== undefined && typeof note !== "string") {
    throw invalid(`"${description}" has a note that is not a string.`);
  }
  return {
    description,
    result,
    screenshots: parseScreenshotList(description, screenshots, captured),
    note,
  };
}

function parseResults(
  resultsPath: string,
  screenshots: string[],
): { ticket: string | null; criteria: CriterionResult[] } {
  let document: { ticket?: unknown; criteria?: unknown };
  try {
    document = JSON.parse(readFileSync(resultsPath, "utf8"));
  } catch (cause) {
    throw invalid(`could not read ${resultsPath}: ${String(cause)}`);
  }
  if (!Array.isArray(document?.criteria) || document.criteria.length === 0) {
    throw invalid('"criteria" must list at least one criterion.');
  }
  const ticket = document.ticket ?? null;
  if (ticket !== null && typeof ticket !== "string") {
    throw invalid('"ticket" must be a string or null.');
  }
  return {
    ticket,
    criteria: document.criteria.map((criterion) => parseCriterion(criterion, screenshots)),
  };
}

/** Catches a screenshot GitHub would refuse now, before the developer reviews the run. */
function assertPublishable(runDirectory: string, screenshots: string[]): void {
  for (const fileName of screenshots) {
    const sizeProblem = imageSizeProblem(statSync(join(screenshotDirectoryOf(runDirectory), fileName)).size);
    if (sizeProblem !== null) {
      throw new CliError("screenshot_invalid", `Screenshot ${fileName} cannot be published: ${sizeProblem}.`);
    }
  }
}

/** Evidence gaps don't fail the run, but the developer should judge them before publishing. */
function missingEvidenceWarnings(criteria: CriterionResult[]): string[] {
  const uncited = criteria.filter((criterion) => criterion.screenshots.length === 0);
  if (uncited.length === 0) {
    return [];
  }
  const names = uncited.map((criterion) => `"${criterion.description}"`).join(", ");
  return [`These criteria cite no screenshots, so the comment shows no proof for them: ${names}.`];
}

export async function finish(
  repositoryPath: string,
  resultsPath: string,
): Promise<RunOutcome & { warnings: string[] }> {
  const repoState = readRepoState(repositoryPath);
  const run = findLatestRun(repoState);
  if (run === null) {
    throw new CliError("no_run", "There is no run to finish. Use start first.");
  }
  await stopLatestRunApp(repoState);

  const screenshots = listScreenshots(run.directory);
  const { ticket, criteria } = parseResults(resultsPath, screenshots);
  assertPublishable(run.directory, screenshots);
  const outcome: RunOutcome = {
    result: criteria.every((criterion) => criterion.result === "pass") ? "pass" : "fail",
    ticket,
    criteria,
    screenshots,
  };
  writeRunRecord(run.directory, { ...findLatestRun(repoState)!.record, outcome });
  return { ...outcome, warnings: missingEvidenceWarnings(criteria) };
}
