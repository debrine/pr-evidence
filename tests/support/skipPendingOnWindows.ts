import { beforeAll, beforeEach } from "vitest";
import { pendingOnWindows } from "./pendingOnWindows.js";

type VitestTask = { type: string; fullTestName?: string; tasks?: VitestTask[] };

function pendingTestsIn(fileName: string): string[] {
  return pendingOnWindows.flatMap((group) => group.tests[fileName] ?? []);
}

function testNamesIn(task: VitestTask): string[] {
  if (task.type === "test") return [task.fullTestName!];
  return (task.tasks ?? []).flatMap(testNamesIn);
}

// Runs on every platform, so a renamed test cannot quietly stop being skipped on Windows.
beforeAll((_context, file) => {
  const testNames = new Set(testNamesIn(file));
  const unknownTests = pendingTestsIn(file.name).filter((testName) => !testNames.has(testName));
  if (unknownTests.length > 0) {
    throw new Error(`pendingOnWindows lists tests that do not exist: ${unknownTests.join(", ")}`);
  }
});

beforeEach((context) => {
  const { file, fullTestName } = context.task;
  if (process.platform === "win32" && pendingTestsIn(file.name).includes(fullTestName!)) {
    context.skip();
  }
});
