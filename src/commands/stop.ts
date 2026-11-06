import { stopApp } from "../appRunner.js";
import { findLatestRun, readRunRecord, writeRunRecord } from "../evidenceStore.js";

/** Stops the app recorded on the repo's latest run. Returns whether one was stopped. */
export async function stopLatestRunApp(repositoryKey: string): Promise<boolean> {
  const runDirectory = findLatestRun(repositoryKey);
  const record = runDirectory === null ? null : readRunRecord(runDirectory);
  if (runDirectory === null || !record?.app) {
    return false;
  }
  const stopped = await stopApp(record.app);
  const { app: _stoppedApp, ...remainingRecord } = record;
  writeRunRecord(runDirectory, remainingRecord);
  return stopped;
}
