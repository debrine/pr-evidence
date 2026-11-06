import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHome, createRepository, git, runCli, startTestServer } from "./support/harness.js";

describe("start", () => {
  it("refuses a dirty working tree", async () => {
    const repository = createRepository();
    writeFileSync(join(repository.path, "app.txt"), "changed\n");

    const result = await runCli(["start", "--url", "http://127.0.0.1:9"], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.ok).toBe(false);
    expect(result.json.error.code).toBe("dirty_working_tree");
  });

  it("records the tested commit in a run directory outside the repo", async () => {
    const repository = createRepository({ branch: "feature/login" });
    const app = await startTestServer();
    const home = createHome();

    const result = await runCli(["start", "--url", app.url], { cwd: repository.path, home });

    expect(result.exitCode).toBe(0);
    expect(result.json.sha).toBe(repository.headSha);
    expect(result.json.branch).toBe("feature/login");
    expect(result.json.dirty).toBe(false);
    expect(result.json.url).toBe(app.url);
    expect(result.json.runDirectory).toBe(
      join(home, ".pr-evidence", "acme__widgets", repository.headSha),
    );
    expect(existsSync(join(result.json.runDirectory, "run.json"))).toBe(true);
    expect(existsSync(result.json.screenshotDirectory)).toBe(true);
    expect(git(repository.path, "status", "--porcelain")).toBe("");
  });

  it("marks a run on a dirty tree when --allow-dirty is passed", async () => {
    const repository = createRepository();
    writeFileSync(join(repository.path, "app.txt"), "changed\n");
    const app = await startTestServer();

    const result = await runCli(["start", "--allow-dirty", "--url", app.url], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.dirty).toBe(true);
    expect(JSON.parse(readFileSync(join(result.json.runDirectory, "run.json"), "utf8")).dirty).toBe(true);
  });

  it("fails clearly when --url is unreachable", async () => {
    const repository = createRepository();

    const result = await runCli(["start", "--url", "http://127.0.0.1:9/"], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("url_unreachable");
  });
});
