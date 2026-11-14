import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeResults, writeSolidPng } from "./support/fixtures.js";
import {
  createHome,
  createRepository,
  createTemporaryDirectory,
  runCli,
  startTestServer,
} from "./support/harness.js";

async function startRun() {
  const repository = createRepository();
  const app = await startTestServer();
  const home = createHome();
  const context = { cwd: repository.path, home };
  const started = await runCli(["start", "--url", app.url], context);
  return { context, started: started.json, resultsDirectory: createTemporaryDirectory() };
}

describe("finish", () => {
  it("records each criterion's screenshots in the order listed, without building a GIF", async () => {
    const { context, started, resultsDirectory } = await startRun();
    writeSolidPng(join(started.screenshotDirectory, "001-form.png"), [255, 0, 0]);
    writeSolidPng(join(started.screenshotDirectory, "002-saving.png"), [0, 0, 255]);
    writeSolidPng(join(started.screenshotDirectory, "003-saved.png"), [0, 255, 0]);
    const criteria = [
      {
        description: "Saving shows progress, then the note",
        result: "pass",
        screenshots: ["002-saving.png", "001-form.png", "003-saved.png"],
      },
      { description: "The saved note is listed", result: "pass", screenshots: ["003-saved.png"] },
    ];
    const results = writeResults(resultsDirectory, { ticket: "ABC-1", criteria });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(0);
    expect(finished.json).not.toHaveProperty("gifPath");
    expect(existsSync(join(started.runDirectory, "evidence.gif"))).toBe(false);
    const record = JSON.parse(readFileSync(join(started.runDirectory, "run.json"), "utf8"));
    expect(record.outcome).toEqual({
      result: "pass",
      ticket: "ABC-1",
      criteria,
      screenshots: ["001-form.png", "002-saving.png", "003-saved.png"],
    });
  });

  describe("screenshot membership", () => {
    it.each(["", ".", "..", "notes.txt", "directory.png"])(
      "rejects a reference outside the captured PNG file set: %j",
      async (screenshot) => {
        const { context, started, resultsDirectory } = await startRun();
        writeFileSync(join(started.screenshotDirectory, "notes.txt"), "not an image");
        if (screenshot === "directory.png") {
          mkdirSync(join(started.screenshotDirectory, screenshot));
        }
        const results = writeResults(resultsDirectory, {
          criteria: [{ description: "It works", result: "pass", screenshots: [screenshot] }],
        });

        const finished = await runCli(["finish", "--results", results], context);

        expect(finished.exitCode).toBe(2);
        expect(finished.json.error.code).toBe("results_invalid");
        const record = JSON.parse(readFileSync(join(started.runDirectory, "run.json"), "utf8"));
        expect(record.outcome).toBeUndefined();
      },
    );

    it("excludes PNG directories from the captured screenshots", async () => {
      const { context, started, resultsDirectory } = await startRun();
      mkdirSync(join(started.screenshotDirectory, "001-directory.png"));
      mkdirSync(join(started.screenshotDirectory, "002-directory.PNG"));
      writeSolidPng(join(started.screenshotDirectory, "003-captured.PNG"), [255, 0, 0]);
      const results = writeResults(resultsDirectory, {
        criteria: [{ description: "It works", result: "pass", screenshots: ["003-captured.PNG"] }],
      });

      const finished = await runCli(["finish", "--results", results], context);

      expect(finished.exitCode).toBe(0);
      expect(finished.json.screenshots).toEqual(["003-captured.PNG"]);
      expect(finished.json.criteria[0].screenshots).toEqual(["003-captured.PNG"]);
    });
  });

  it("exits 1 and still produces evidence when a criterion fails", async () => {
    const { context, started, resultsDirectory } = await startRun();
    writeSolidPng(join(started.screenshotDirectory, "001-broken.png"), [255, 0, 0]);
    const results = writeResults(resultsDirectory, {
      criteria: [
        { description: "It loads", result: "pass", screenshots: [] },
        {
          description: "It saves",
          result: "fail",
          screenshots: ["001-broken.png"],
          note: "500 error",
        },
      ],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(1);
    expect(finished.json.ok).toBe(true);
    expect(finished.json.result).toBe("fail");
    const record = JSON.parse(readFileSync(join(started.runDirectory, "run.json"), "utf8"));
    expect(record.outcome.result).toBe("fail");
    expect(record.outcome.criteria[1].screenshots).toEqual(["001-broken.png"]);
  });

  it.each([
    ["no criteria", { criteria: [] }, /criteria/],
    [
      "an unknown result",
      { criteria: [{ description: "x", result: "maybe", screenshots: [] }] },
      /result/,
    ],
    ["a missing description", { criteria: [{ result: "pass", screenshots: [] }] }, /description/],
    [
      "screenshots that are not a list",
      { criteria: [{ description: "x", result: "pass", screenshots: "nope.png" }] },
      /screenshots/,
    ],
    [
      "a screenshot outside the run",
      { criteria: [{ description: "x", result: "pass", screenshots: ["../../secret.png"] }] },
      /screenshot/,
    ],
    [
      "the same screenshot twice in one criterion",
      { criteria: [{ description: "x", result: "pass", screenshots: ["001-form.png", "001-form.png"] }] },
      /001-form\.png.*more than once/,
    ],
    [
      "a screenshot name that is not a string",
      { criteria: [{ description: "x", result: "pass", screenshots: [5] }] },
      /file name/,
    ],
    [
      "a screenshot that does not exist",
      { criteria: [{ description: "x", result: "pass", screenshots: ["nope.png"] }] },
      /nope\.png/,
    ],
  ])("rejects results with %s", async (_name, content, expectedMessage) => {
    const { context, started, resultsDirectory } = await startRun();
    writeSolidPng(join(started.screenshotDirectory, "001-form.png"), [255, 0, 0]);
    const results = writeResults(resultsDirectory, content);

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(2);
    expect(finished.json.error.code).toBe("results_invalid");
    expect(finished.json.error.message).toMatch(expectedMessage);
  });

  it("warns once, naming each criterion that cites no screenshots", async () => {
    const { context, started, resultsDirectory } = await startRun();
    writeSolidPng(join(started.screenshotDirectory, "001-form.png"), [255, 0, 0]);
    const results = writeResults(resultsDirectory, {
      criteria: [
        { description: "The form appears", result: "pass", screenshots: ["001-form.png"] },
        { description: "The request is sent once", result: "pass", screenshots: [] },
        { description: "No error is logged", result: "pass", screenshots: [] },
      ],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(0);
    expect(finished.json.warnings).toHaveLength(1);
    expect(finished.json.warnings[0]).toContain('"The request is sent once"');
    expect(finished.json.warnings[0]).toContain('"No error is logged"');
    expect(finished.json.warnings[0]).not.toContain("The form appears");
  });

  it("gives no warning when every criterion cites a screenshot", async () => {
    const { context, started, resultsDirectory } = await startRun();
    writeSolidPng(join(started.screenshotDirectory, "001-form.png"), [255, 0, 0]);
    const results = writeResults(resultsDirectory, {
      criteria: [{ description: "The form appears", result: "pass", screenshots: ["001-form.png"] }],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.json.warnings).toEqual([]);
  });

  it.each([
    ["empty", 0],
    ["over GitHub's 10 MiB image limit", 10 * 1024 * 1024 + 1],
  ])("exits 2 naming a screenshot that is %s, even when no criterion cites it", async (
    _problem,
    size,
  ) => {
    const { context, started, resultsDirectory } = await startRun();
    writeSolidPng(join(started.screenshotDirectory, "001-form.png"), [255, 0, 0]);
    writeFileSync(join(started.screenshotDirectory, "002-unusable.png"), Buffer.alloc(size));
    const results = writeResults(resultsDirectory, {
      criteria: [{ description: "The form appears", result: "pass", screenshots: ["001-form.png"] }],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(2);
    expect(finished.json.error.code).toBe("screenshot_invalid");
    expect(finished.json.error.message).toContain("002-unusable.png");
    const record = JSON.parse(readFileSync(join(started.runDirectory, "run.json"), "utf8"));
    expect(record.outcome).toBeUndefined();
  });

  it("accepts a screenshot of exactly 10 MiB", async () => {
    const { context, started, resultsDirectory } = await startRun();
    writeFileSync(join(started.screenshotDirectory, "001-large.png"), Buffer.alloc(10 * 1024 * 1024, 1));
    const results = writeResults(resultsDirectory, {
      criteria: [{ description: "The page loads", result: "pass", screenshots: ["001-large.png"] }],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(0);
  });

  it("rejects the old single screenshot field and names its replacement", async () => {
    const { context, started, resultsDirectory } = await startRun();
    writeSolidPng(join(started.screenshotDirectory, "001-form.png"), [255, 0, 0]);
    const results = writeResults(resultsDirectory, {
      criteria: [{ description: "The form appears", result: "pass", screenshot: "001-form.png" }],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(2);
    expect(finished.json.error.code).toBe("results_invalid");
    expect(finished.json.error.message).toContain('"screenshot"');
    expect(finished.json.error.message).toContain("screenshots: [...]");
  });

  it("fails clearly when there is no run to finish", async () => {
    const repository = createRepository();
    const results = writeResults(createTemporaryDirectory(), {
      criteria: [{ description: "x", result: "pass", screenshots: [] }],
    });

    const finished = await runCli(["finish", "--results", results], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(finished.exitCode).toBe(2);
    expect(finished.json.error.code).toBe("no_run");
  });
});
