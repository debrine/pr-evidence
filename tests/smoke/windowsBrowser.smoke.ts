import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  formatBrowserSmokeReport,
  startBrowserSmoke,
  type BrowserSmoke,
  type BrowserSmokeFindings,
} from "../support/browserSmoke.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let smoke: BrowserSmoke;
const findings: BrowserSmokeFindings = { survivors: null, reopened: null };

beforeAll(async () => {
  smoke = await startBrowserSmoke();
});

afterAll(async () => {
  try {
    const report = formatBrowserSmokeReport(findings);
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  } finally {
    await smoke?.cleanUp();
  }
});

it("opens the sample app and takes a screenshot", async () => {
  await smoke.browser("open", smoke.appUrl);
  const screenshotPath = join(smoke.workDirectory, "first.png");

  await smoke.browser("screenshot", screenshotPath);

  expect(readFileSync(screenshotPath).subarray(0, 8)).toEqual(PNG_SIGNATURE);
});

// Without this, a detector that matches nothing would report a clean stop.
it("sees the bridge, the MCP server and Chrome while they run", async () => {
  const processes = await smoke.trackBrowserProcesses();

  expect(processes.map((browserProcess) => browserProcess.kind)).toEqual(
    expect.arrayContaining(["bridge", "chrome-devtools-mcp", "chrome"]),
  );
});

// Survivors are reported, not failed: the cleanup ticket decides what to do about them.
it("stops the browser and records what survives", async () => {
  await smoke.browser("stop");

  findings.survivors = await smoke.findSurvivors();
});

it("reopens with the same profile", async () => {
  findings.reopened = false;
  await smoke.browser("open", smoke.appUrl);
  const screenshotPath = join(smoke.workDirectory, "second.png");

  await smoke.browser("screenshot", screenshotPath);

  expect(readFileSync(screenshotPath).subarray(0, 8)).toEqual(PNG_SIGNATURE);
  findings.reopened = true;
});
