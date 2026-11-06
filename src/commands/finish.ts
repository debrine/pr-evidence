import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors.js";
import {
  findLatestRun,
  gifPathOf,
  listScreenshots,
  readRunRecord,
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

export async function finish(repositoryPath: string, resultsPath: string): Promise<RunOutcome> {
  const { repositoryKey } = readRepoState(repositoryPath);
  const runDirectory = findLatestRun(repositoryKey);
  if (runDirectory === null) {
    throw new CliError("no_run", "There is no run to finish. Use start first.");
  }
  await stopLatestRunApp(repositoryKey);

  const screenshots = listScreenshots(runDirectory);
  const { ticket, criteria } = parseResults(resultsPath, screenshots);
  let gifPath: string | null = null;
  if (screenshots.length > 0) {
    gifPath = gifPathOf(runDirectory);
    buildGif(
      screenshots.map((fileName) => join(screenshotDirectoryOf(runDirectory), fileName)),
      gifPath,
    );
  }
  const outcome: RunOutcome = {
    result: criteria.every((criterion) => criterion.result === "pass") ? "pass" : "fail",
    ticket,
    criteria,
    screenshots,
    gifPath,
  };
  writeRunRecord(runDirectory, { ...readRunRecord(runDirectory)!, outcome });
  return outcome;
}
