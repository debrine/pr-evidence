import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors.js";
import {
  findLatestRun,
  gifPathOf,
  listScreenshots,
  screenshotDirectoryOf,
  writeRunRecord,
  type CriterionResult,
  type RunOutcome,
} from "../evidenceStore.js";
import { buildGif } from "../gifBuilder.js";
import { readRepoState } from "../repoState.js";
import { stopLatestRunApp } from "./stop.js";

function invalid(problem: string): CliError {
  return new CliError("results_invalid", `Results file: ${problem}`);
}

function parseCriterion(value: unknown, screenshots: string[]): CriterionResult {
  const { description, result, screenshot, note } = (value ?? {}) as Record<string, unknown>;
  if (typeof description !== "string" || description.trim() === "") {
    throw invalid('every criterion needs a "description".');
  }
  if (result !== "pass" && result !== "fail") {
    throw invalid(`"${description}" needs a result of "pass" or "fail".`);
  }
  if (note !== undefined && typeof note !== "string") {
    throw invalid(`"${description}" has a note that is not a string.`);
  }
  if (screenshot === undefined) {
    return { description, result, note };
  }
  if (typeof screenshot !== "string" || !screenshots.includes(screenshot)) {
    throw invalid(`"${description}" names screenshot ${screenshot}, which was not captured.`);
  }
  return { description, result, screenshot, note };
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

/** A GIF failure must not cost the run its evidence, so it is a warning here. */
function tryBuildGif(
  runDirectory: string,
  screenshots: string[],
  warnings: string[],
): string | null {
  if (screenshots.length === 0) {
    return null;
  }
  const gifPath = gifPathOf(runDirectory);
  try {
    buildGif(
      screenshots.map((fileName) => join(screenshotDirectoryOf(runDirectory), fileName)),
      gifPath,
    );
    return gifPath;
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    warnings.push(`No GIF was built. ${error.message}`);
    return null;
  }
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
  const warnings: string[] = [];
  const gifPath = tryBuildGif(run.directory, screenshots, warnings);
  const outcome: RunOutcome = {
    result: criteria.every((criterion) => criterion.result === "pass") ? "pass" : "fail",
    ticket,
    criteria,
    screenshots,
    gifPath,
  };
  writeRunRecord(run.directory, { ...findLatestRun(repoState)!.record, outcome });
  return { ...outcome, warnings };
}
