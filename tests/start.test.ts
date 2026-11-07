import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { startFakeGitHub, type FakeGitHubOptions } from "./support/fakeGitHub.js";
import {
  createHome,
  createRepository,
  createToolShims,
  git,
  runCli,
  startTestServer,
} from "./support/harness.js";

describe("start", () => {
  it("returns a valid, deterministic browser session per repository", async () => {
    const repository = createRepository();
    const home = createHome();
    const app = await startTestServer();
    const sessionForStart = async () => {
      const result = await runCli(["start", "--url", app.url], { cwd: repository.path, home });
      expect(result.exitCode).toBe(0);
      return execFileSync("/bin/sh", [
        "-c", `${result.json.browser.commandPrefix} "$@"`, "browser-session-test",
        process.execPath, "-p", "process.env.CHROME_DEVTOOLS_AXI_SESSION",
      ], { encoding: "utf8" }).trim();
    };

    const session = await sessionForStart();
    expect(session).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(await sessionForStart()).toBe(session);
    git(repository.path, "remote", "set-url", "origin", "git@github.com:acme/other.git");
    expect(await sessionForStart()).not.toBe(session);
  });

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

  it.each(["untracked files", "modified submodule files", "untracked submodule files"])(
    "ignores Git display preferences when guarding and recording %s",
    async (change) => {
      const repository = createRepository();
      git(repository.path, "config", "status.showUntrackedFiles", "no");
      git(repository.path, "config", "diff.ignoreSubmodules", "all");
      if (change === "untracked files") {
        writeFileSync(join(repository.path, "new-source.txt"), "uncommitted source");
      } else {
        const submodule = createRepository();
        git(repository.path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule.path, "dependency");
        git(repository.path, "commit", "-q", "-am", "add submodule");
        const name = change === "modified submodule files" ? "app.txt" : "new-source.txt";
        writeFileSync(join(repository.path, "dependency", name), "uncommitted source");
      }
      const home = createHome();
      const app = await startTestServer();
      const refused = await runCli(["start", "--url", app.url], { cwd: repository.path, home });
      const allowed = await runCli(["start", "--allow-dirty", "--url", app.url], { cwd: repository.path, home });
      console.log("Git display preferences CLI", JSON.stringify({ change, refused, allowed }));
      expect(refused.exitCode).toBe(2);
      expect(refused.json.error.code).toBe("dirty_working_tree");
      expect(allowed.exitCode).toBe(0);
      expect(allowed.json.dirty).toBe(true);
      expect(JSON.parse(readFileSync(join(allowed.json.runDirectory, "run.json"), "utf8")).dirty).toBe(true);
    },
  );

  it("keeps the same network identity across default transports and explicit default ports", async () => {
    const repository = createRepository();
    const home = createHome();
    const app = await startTestServer();
    const first = await runCli(["start", "--url", app.url], { cwd: repository.path, home });
    for (const origin of [
      "https://github.com/acme/widgets.git", "https://github.com:443/acme/widgets.git",
      "http://github.com:80/acme/widgets.git", "ssh://git@github.com:22/acme/widgets.git",
    ]) {
      git(repository.path, "remote", "set-url", "origin", origin);
      const next = await runCli(["start", "--url", app.url], { cwd: repository.path, home });
      expect(next.exitCode).toBe(0);
      expect(next.json.runDirectory).toBe(first.json.runDirectory);
    }
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
    expect(basename(result.json.runDirectory)).toBe(repository.headSha);
    expect(dirname(dirname(result.json.runDirectory))).toBe(join(home, ".pr-evidence"));
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

describe("start, comparing the commit with the open PR", () => {
  const branch = "feature/login";
  const remoteHeadSha = "f".repeat(40);

  async function startWithGitHub(
    fakeGitHubOptions: (headSha: string) => FakeGitHubOptions,
    prepare: (repositoryPath: string) => void = () => {},
  ) {
    const repository = createRepository({ branch });
    const github = await startFakeGitHub(fakeGitHubOptions(repository.headSha));
    const app = await startTestServer();
    prepare(repository.path);
    const result = await runCli(["start", "--url", app.url], {
      cwd: repository.path,
      home: createHome(),
      env: { PR_EVIDENCE_GITHUB_BASE_URL: github.baseUrl },
    });
    return { repository, result };
  }

  it("warns before testing when the commit is not the head of the open PR", async () => {
    const { repository, result } = await startWithGitHub(() => ({
      pullRequests: [{ number: 7, branch, headSha: remoteHeadSha }],
    }));

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toHaveLength(1);
    expect(result.json.warnings[0]).toContain(repository.headSha);
    expect(result.json.warnings[0]).toContain("PR #7");
    expect(result.json.warnings[0]).toContain(remoteHeadSha);
  });

  it("stays quiet when the commit is the head of the open PR", async () => {
    const { result } = await startWithGitHub((headSha) => ({
      pullRequests: [{ number: 7, branch, headSha }],
    }));

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toEqual([]);
  });

  it("stays quiet when the branch has no open PR yet", async () => {
    const { result } = await startWithGitHub(() => ({ pullRequests: [] }));

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toEqual([]);
  });

  it("does not look for a PR from a detached commit", async () => {
    const { result } = await startWithGitHub(
      () => ({ pullRequests: [{ number: 7, branch, headSha: remoteHeadSha }] }),
      (repositoryPath) => git(repositoryPath, "checkout", "-q", "--detach"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.json.branch).toBeNull();
    expect(result.json.warnings).toEqual([]);
  });

  it("still starts, and says so, when GitHub cannot be reached", async () => {
    const repository = createRepository({ branch });
    const app = await startTestServer();

    const result = await runCli(["start", "--url", app.url], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toHaveLength(1);
    expect(result.json.warnings[0]).toContain("Could not compare this commit with the open PR");
  });

  it("still starts, and says so, when gh has a token GitHub refuses for uploads", async () => {
    const repository = createRepository({ branch });
    const app = await startTestServer();

    const result = await runCli(["start", "--url", app.url], {
      cwd: repository.path,
      home: createHome(),
      toolShims: createToolShims({ ghToken: "ghs_apptoken" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toHaveLength(1);
    expect(result.json.warnings[0]).toContain("Could not compare this commit with the open PR");
    expect(result.json.warnings[0]).toContain("gh auth login");
  });

  it.each([
    ["gh is missing", null, undefined, "gh auth login"],
    ["the host is unsupported", undefined, "git@git.example.com:acme/widgets.git", "not supported"],
  ])("gives only the publishing warning when %s", async (_case, ghToken, remoteUrl, expected) => {
    const repository = createRepository({ branch, remoteUrl });
    const app = await startTestServer();

    const result = await runCli(["start", "--url", app.url], {
      cwd: repository.path,
      home: createHome(),
      toolShims: createToolShims({ ghToken }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toHaveLength(1);
    expect(result.json.warnings[0]).toContain(expected);
  });
});
