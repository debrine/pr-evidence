import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decompressFrames, parseGIF } from "gifuct-js";
import { describe, expect, it } from "vitest";
import { writeNoisePng, writeResults, writeSolidPng } from "./support/fixtures.js";
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

function decodeGif(path: string) {
  const buffer = readFileSync(path);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
  return decompressFrames(parseGIF(arrayBuffer as ArrayBuffer), true);
}

describe("finish", () => {
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
          criteria: [{ description: "It works", result: "pass", screenshot }],
        });

        const finished = await runCli(["finish", "--results", results], context);

        expect(finished.exitCode).toBe(2);
        expect(finished.json.error.code).toBe("results_invalid");
        const record = JSON.parse(readFileSync(join(started.runDirectory, "run.json"), "utf8"));
        expect(record.outcome).toBeUndefined();
      },
    );

    it("excludes PNG directories from evidence and GIF frames", async () => {
      const { context, started, resultsDirectory } = await startRun();
      mkdirSync(join(started.screenshotDirectory, "001-directory.png"));
      mkdirSync(join(started.screenshotDirectory, "002-directory.PNG"));
      writeSolidPng(join(started.screenshotDirectory, "003-captured.PNG"), [255, 0, 0]);
      const results = writeResults(resultsDirectory, {
        criteria: [{ description: "It works", result: "pass", screenshot: "003-captured.PNG" }],
      });

      const finished = await runCli(["finish", "--results", results], context);

      expect(finished.exitCode).toBe(0);
      expect(finished.json.screenshots).toEqual(["003-captured.PNG"]);
      expect(finished.json.criteria[0].screenshot).toBe("003-captured.PNG");
      expect(decodeGif(finished.json.gifPath)).toHaveLength(1);
      const record = JSON.parse(readFileSync(join(started.runDirectory, "run.json"), "utf8"));
      expect(record.outcome).toEqual({
        result: "pass",
        ticket: null,
        criteria: [{ description: "It works", result: "pass", screenshot: "003-captured.PNG" }],
        screenshots: ["003-captured.PNG"],
        gifPath: finished.json.gifPath,
      });
    });
  });

  it("stitches the screenshots, in order, into a step-by-step GIF", async () => {
    const { context, started, resultsDirectory } = await startRun();
    writeSolidPng(join(started.screenshotDirectory, "002-blue.png"), [0, 0, 255]);
    writeSolidPng(join(started.screenshotDirectory, "001-red.png"), [255, 0, 0]);
    writeSolidPng(join(started.screenshotDirectory, "003-green.png"), [0, 255, 0]);
    const results = writeResults(resultsDirectory, {
      ticket: "ABC-1",
      criteria: [{ description: "It works", result: "pass", screenshot: "003-green.png" }],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(0);
    expect(finished.json.result).toBe("pass");
    const frames = decodeGif(finished.json.gifPath);
    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.delay)).toEqual([1500, 1500, 1500]);
    const firstPixels = frames.map((frame) => Array.from(frame.patch.slice(0, 3)));
    expect(firstPixels[0]![0]).toBeGreaterThan(200);
    expect(firstPixels[1]![2]).toBeGreaterThan(200);
    expect(firstPixels[2]![1]).toBeGreaterThan(200);
  });

  it("handles screenshots of different sizes, as after a browser resize", async () => {
    const { context, started, resultsDirectory } = await startRun();
    writeSolidPng(join(started.screenshotDirectory, "001-small.png"), [255, 0, 0], 20, 10);
    writeSolidPng(join(started.screenshotDirectory, "002-large.png"), [0, 0, 255], 60, 40);
    const results = writeResults(resultsDirectory, {
      criteria: [{ description: "It works", result: "pass" }],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(0);
    const frames = decodeGif(finished.json.gifPath);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.dims.width).toBe(frames[1]!.dims.width);
    expect(frames[0]!.dims.height).toBe(frames[1]!.dims.height);
  });

  it("keeps a long run under the 10 MiB image limit", async () => {
    const { context, started, resultsDirectory } = await startRun();
    for (let step = 1; step <= 14; step += 1) {
      const name = `${String(step).padStart(3, "0")}-step.png`;
      writeNoisePng(join(started.screenshotDirectory, name), 1200, 800);
    }
    const results = writeResults(resultsDirectory, {
      criteria: [{ description: "It works", result: "pass" }],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(0);
    expect(statSync(finished.json.gifPath).size).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(decodeGif(finished.json.gifPath).length).toBeGreaterThan(1);
  }, 120_000);

  it("exits 1 and still produces evidence when a criterion fails", async () => {
    const { context, started, resultsDirectory } = await startRun();
    writeSolidPng(join(started.screenshotDirectory, "001-broken.png"), [255, 0, 0]);
    const results = writeResults(resultsDirectory, {
      criteria: [
        { description: "It loads", result: "pass" },
        { description: "It saves", result: "fail", screenshot: "001-broken.png", note: "500 error" },
      ],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(1);
    expect(finished.json.ok).toBe(true);
    expect(finished.json.result).toBe("fail");
    expect(existsSync(finished.json.gifPath)).toBe(true);
  });

  it("finishes without a GIF when there are no screenshots", async () => {
    const { context, resultsDirectory } = await startRun();
    const results = writeResults(resultsDirectory, {
      criteria: [{ description: "It works", result: "fail", note: "The page never loaded" }],
    });

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(1);
    expect(finished.json.gifPath).toBeNull();
  });

  it.each([
    ["no criteria", { criteria: [] }, /criteria/],
    ["an unknown result", { criteria: [{ description: "x", result: "maybe" }] }, /result/],
    ["a missing description", { criteria: [{ result: "pass" }] }, /description/],
    [
      "a screenshot outside the run",
      { criteria: [{ description: "x", result: "pass", screenshot: "../../secret.png" }] },
      /screenshot/,
    ],
    [
      "a screenshot that does not exist",
      { criteria: [{ description: "x", result: "pass", screenshot: "nope.png" }] },
      /nope\.png/,
    ],
  ])("rejects results with %s", async (_name, content, expectedMessage) => {
    const { context, resultsDirectory } = await startRun();
    const results = writeResults(resultsDirectory, content);

    const finished = await runCli(["finish", "--results", results], context);

    expect(finished.exitCode).toBe(2);
    expect(finished.json.error.code).toBe("results_invalid");
    expect(finished.json.error.message).toMatch(expectedMessage);
  });

  it("fails clearly when there is no run to finish", async () => {
    const repository = createRepository();
    const results = writeResults(createTemporaryDirectory(), {
      criteria: [{ description: "x", result: "pass" }],
    });

    const finished = await runCli(["finish", "--results", results], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(finished.exitCode).toBe(2);
    expect(finished.json.error.code).toBe("no_run");
  });
});
