import { stopApp } from "../appRunner.js";
import { findLatestRun, writeRunRecord } from "../evidenceStore.js";
import type { RepoState } from "../repoState.js";

/** Stops the app recorded on this checkout's latest run. Returns whether one was stopped. */
export async function stopLatestRunApp(repoState: RepoState): Promise<boolean> {
  const run = findLatestRun(repoState);
  if (run === null || run.record.app === undefined) {
    return false;
  }
  const stopped = await stopApp(run.record.app);
  const { app: _stoppedApp, ...remainingRecord } = run.record;
  writeRunRecord(run.directory, remainingRecord);
  return stopped;
}
