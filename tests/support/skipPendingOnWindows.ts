import { beforeAll, beforeEach, type RunnerTask } from "vitest";
import { pendingOnWindows } from "./pendingOnWindows.js";

function pendingTestsIn(fileName: string): string[] {
  return pendingOnWindows.flatMap((group) => group.tests[fileName] ?? []);
}

function testNamesIn(task: RunnerTask): string[] {
  if (task.type === "test") return [task.fullTestName!];
  return task.tasks.flatMap(testNamesIn);
}

// Runs on every platform, so a renamed test cannot quietly stop being skipped on Windows.
// Vitest requires the first argument to be a destructuring pattern, even when unused.
beforeAll(({}, file) => {
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
