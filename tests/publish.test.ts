import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startFakeGitHub, type FakeGitHub, type FakeGitHubOptions } from "./support/fakeGitHub.js";
import { writeResults, writeSolidPng } from "./support/fixtures.js";
import {
  createHome,
  createRepository,
  createTemporaryDirectory,
  createToolShims,
  git,
  runCli,
  startTestServer,
} from "./support/harness.js";

const branch = "feature/login";
const passingResults = {
  ticket: "ABC-1",
  criteria: [
    { description: "The login form appears", result: "pass", screenshot: "001-login.png" },
    { description: "Signing in shows the dashboard", result: "pass" },
  ],
};

interface RunSetup {
  fakeGitHubOptions?: (headSha: string) => FakeGitHubOptions;
  results?: unknown;
  remoteUrl?: string;
  ghToken?: string | null;
  dirty?: boolean;
}

async function finishedRun(setup: RunSetup = {}) {
  const repository = createRepository({ branch, remoteUrl: setup.remoteUrl });
  const github: FakeGitHub = await startFakeGitHub(
    setup.fakeGitHubOptions?.(repository.headSha) ?? {
      pullRequests: [{ number: 7, branch, headSha: repository.headSha }],
    },
  );
  const app = await startTestServer();
  const context = {
    cwd: repository.path,
    home: createHome(),
    env: { PR_EVIDENCE_GITHUB_BASE_URL: github.baseUrl },
    toolShims: createToolShims({ ghToken: setup.ghToken }),
  };
  if (setup.dirty) {
    writeFileSync(join(repository.path, "app.txt"), "changed\n");
  }
  const startArgs = ["start", "--url", app.url, ...(setup.dirty ? ["--allow-dirty"] : [])];
  const started = await runCli(startArgs, context);
  writeSolidPng(join(started.json.screenshotDirectory, "001-login.png"), [255, 0, 0]);
  writeSolidPng(join(started.json.screenshotDirectory, "002-dashboard.png"), [0, 0, 255]);
  const results = writeResults(createTemporaryDirectory(), setup.results ?? passingResults);
  await runCli(["finish", "--results", results], context);
  return { repository, github, context, started: started.json };
}

describe("publish", () => {
  it("uploads the GIF and screenshots with the documented request shape", async () => {
    const { github, context } = await finishedRun();

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(0);
    expect(github.uploads.map((upload) => upload.name).sort()).toEqual([
      "001-login.png",
      "002-dashboard.png",
      "evidence.gif",
    ]);
    const gif = github.uploads.find((upload) => upload.name === "evidence.gif")!;
    expect(gif.contentType).toBe("image/gif");
    expect(gif.repositoryId).toBe("4242");
    expect(gif.authorization).toBe("Bearer gho_testtoken");
    expect(gif.requestContentType).toBe("application/octet-stream");
    expect(gif.accept).toBe("application/vnd.github+json");
    expect(gif.size).toBeGreaterThan(0);
    const screenshot = github.uploads.find((upload) => upload.name === "001-login.png")!;
    expect(screenshot.contentType).toBe("image/png");
  });

  it("posts one comment with the result, commit, ticket, criteria, GIF and collapsed screenshots", async () => {
    const { repository, github, context } = await finishedRun();

    const published = await runCli(["publish"], context);

    expect(published.json.pullRequest.number).toBe(7);
    expect(published.json.commentUrl).toContain("/comment/");
    expect(github.comments).toHaveLength(1);
    const { body } = github.comments[0]!;
    expect(body).toContain("<!-- pr-evidence -->");
    expect(body).toContain("Passed");
    expect(body).toContain(repository.headSha);
    expect(body).toContain("ABC-1");
    expect(body).toMatch(/\| Pass \| The login form appears/);
    expect(body).toMatch(/!\[.*\]\(https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+\)/);
    expect(body).toContain("<details>");
    expect(body).toContain("001-login.png");
    expect(body).toContain("002-dashboard.png");
  });

  it("replaces its own comment on a rerun instead of adding another", async () => {
    const { github, context } = await finishedRun();

    await runCli(["publish"], context);
    await runCli(["publish"], context);

    expect(github.comments).toHaveLength(1);
    expect(github.commentWrites.map((write) => write.method)).toEqual(["POST", "PATCH"]);
  });

  it("finds its comment past the first page of comments", async () => {
    const otherComments = Array.from({ length: 120 }, (_unused, index) => ({
      id: index + 1,
      body: "unrelated",
      user: { login: "someone" },
    }));
    const { github, context } = await finishedRun({
      fakeGitHubOptions: (headSha) => ({
        pullRequests: [{ number: 7, branch, headSha }],
        comments: [
          ...otherComments,
          { id: 500, body: "<!-- pr-evidence -->\nold", user: { login: "tester" } },
        ],
      }),
    });

    await runCli(["publish"], context);

    expect(github.commentWrites).toEqual([
      { method: "PATCH", path: "/repos/acme/widgets/issues/comments/500" },
    ]);
  });

  it("never edits a comment by someone else that carries the marker", async () => {
    const planted = { id: 500, body: "<!-- pr-evidence -->\nplanted", user: { login: "stranger" } };
    const { github, context } = await finishedRun({
      fakeGitHubOptions: (headSha) => ({
        pullRequests: [{ number: 7, branch, headSha }],
        comments: [planted],
      }),
    });

    await runCli(["publish"], context);

    expect(github.commentWrites.map((write) => write.method)).toEqual(["POST"]);
    expect(github.comments[0]!.body).toContain("planted");
  });

  it("shows a failing criterion's screenshot and note in the open", async () => {
    const { github, context } = await finishedRun({
      results: {
        ticket: null,
        criteria: [
          {
            description: "Saving works",
            result: "fail",
            screenshot: "002-dashboard.png",
            note: "A 500 error appeared",
          },
        ],
      },
    });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(0);
    const { body } = github.comments[0]!;
    expect(body).toContain("Failed");
    expect(body).toMatch(/\| Fail \| Saving works \| A 500 error appeared/);
    expect(body).toContain("No ticket");
    const beforeDetails = body.split("<details>")[0]!;
    expect(beforeDetails).toMatch(/!\[002-dashboard\.png\]\(https:/);
  });

  it("keeps criterion text from breaking the table or injecting markup", async () => {
    const { github, context } = await finishedRun({
      results: {
        criteria: [
          { description: "a | b\nc <img src=x>", result: "pass", note: "x | y" },
        ],
      },
    });

    await runCli(["publish"], context);

    const { body } = github.comments[0]!;
    expect(body).toContain("a \\| b c &lt;img src=x&gt;");
    expect(body).toContain("x \\| y");
  });

  it("marks evidence from a dirty tree", async () => {
    const { github, context } = await finishedRun({ dirty: true });

    await runCli(["publish"], context);

    expect(github.comments[0]!.body).toContain("uncommitted changes");
  });

  it("does not mark evidence from a clean tree", async () => {
    const { github, context } = await finishedRun();

    await runCli(["publish"], context);

    expect(github.comments[0]!.body).not.toContain("uncommitted changes");
  });

  it("warns in neutral words when the tested commit is on GitHub but is not the PR head", async () => {
    const { github, context } = await finishedRun({
      fakeGitHubOptions: (headSha) => ({
        pullRequests: [{ number: 7, branch, headSha: "f".repeat(40) }],
        commits: [headSha],
      }),
    });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(0);
    expect(published.json.warnings.join(" ")).toContain("The PR head differs from the tested commit");
    expect(github.comments[0]!.body).toContain("The PR head differs from the tested commit");
    expect(github.comments[0]!.body).not.toContain("moved past");
    expect(github.comments[0]!.body).toContain(`compare/`);
  });

  it("refuses a tested commit that is not on GitHub, leaving the PR untouched", async () => {
    const existingBody = "<!-- pr-evidence -->\nEarlier evidence";
    const { github, context, started } = await finishedRun({
      fakeGitHubOptions: () => ({
        pullRequests: [{ number: 7, branch, headSha: "f".repeat(40) }],
        comments: [{ id: 1, body: existingBody, user: { login: "tester" } }],
      }),
    });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(2);
    expect(published.json.error.code).toBe("commit_not_on_github");
    expect(published.json.error.message).toMatch(/push/i);
    expect(published.json.error.message).toContain(started.sha);
    expect(github.uploads).toEqual([]);
    expect(github.commentWrites).toEqual([]);
    expect(github.comments.map((comment) => comment.body)).toEqual([existingBody]);
  });

  it("fails closed when GitHub cannot say whether it has the tested commit", async () => {
    const { github, context } = await finishedRun({
      fakeGitHubOptions: (headSha) => ({
        pullRequests: [{ number: 7, branch, headSha: "f".repeat(40) }],
        commits: [headSha],
        commitLookupStatus: 500,
      }),
    });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(2);
    expect(published.json.error.code).toBe("github_request_failed");
    expect(github.uploads).toEqual([]);
    expect(github.commentWrites).toEqual([]);
  });

  it("keeps the evidence and reports when the branch has no PR yet", async () => {
    const { github, context, started } = await finishedRun({
      fakeGitHubOptions: () => ({ pullRequests: [] }),
    });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(2);
    expect(published.json.error.code).toBe("no_pull_request");
    expect(github.uploads).toHaveLength(0);
    expect(existsSync(started.runDirectory)).toBe(true);
  });

  it("publishes saved evidence once the PR exists, without repeating the run", async () => {
    const { repository, github, context } = await finishedRun({
      fakeGitHubOptions: (headSha) => ({ pullRequests: [{ number: 9, branch, headSha }] }),
    });
    git(repository.path, "checkout", "-q", "-b", "other-work");

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(0);
    expect(published.json.pullRequest.number).toBe(9);
    expect(github.comments).toHaveLength(1);
  });

  it.each([
    ["a server error", () => ({ status: 500, body: "boom" })],
    ["a surprising URL", () => ({ status: 201, body: '{"url":"https://evil.example/x"}' })],
    ["a non-JSON body", () => ({ status: 201, body: "<html>" })],
    [
      "a wrong path on the right host",
      () => ({ status: 201, body: '{"url":"https://github.com/user-attachments/files/1"}' }),
    ],
  ])("fails closed on %s: no comment, files kept", async (_name, uploadResponse) => {
    const { github, context, started } = await finishedRun({
      fakeGitHubOptions: (headSha) => ({
        pullRequests: [{ number: 7, branch, headSha }],
        uploadResponse: (_fileName, uploadCount) => (uploadCount === 2 ? uploadResponse() : null),
      }),
    });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(2);
    expect(published.json.error.code).toBe("upload_failed");
    expect(github.comments).toHaveLength(0);
    expect(existsSync(join(started.runDirectory, "evidence.gif"))).toBe(true);
  });

  it("can retry after a failed upload", async () => {
    let failing = true;
    const { github, context } = await finishedRun({
      fakeGitHubOptions: (headSha) => ({
        pullRequests: [{ number: 7, branch, headSha }],
        uploadResponse: () => (failing ? { status: 500, body: "boom" } : null),
      }),
    });

    await runCli(["publish"], context);
    failing = false;
    const retried = await runCli(["publish"], context);

    expect(retried.exitCode).toBe(0);
    expect(github.comments).toHaveLength(1);
  });

  it.each(["ghs_installation", "ghu_usertoserver", "unknownformat"])(
    "refuses a %s token before any upload",
    async (ghToken) => {
      const { github, context } = await finishedRun({ ghToken });

      const published = await runCli(["publish"], context);

      expect(published.exitCode).toBe(2);
      expect(published.json.error.code).toBe("token_refused");
      expect(github.uploads).toHaveLength(0);
    },
  );

  it.each(["ghp_classic", "github_pat_finegrained"])("accepts a %s token", async (ghToken) => {
    const { context } = await finishedRun({ ghToken });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(0);
  });

  it.each(["READ", "TRIAGE"])("refuses %s permission before any upload", async (viewerPermission) => {
    const { github, context } = await finishedRun({
      fakeGitHubOptions: (headSha) => ({
        viewerPermission,
        pullRequests: [{ number: 7, branch, headSha }],
      }),
    });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(2);
    expect(published.json.error.code).toBe("permission_denied");
    expect(github.uploads).toHaveLength(0);
  });

  it("refuses GitHub Enterprise Server with a clear message", async () => {
    const { github, context } = await finishedRun({
      remoteUrl: "git@git.corp.example:acme/widgets.git",
    });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(2);
    expect(published.json.error.code).toBe("unsupported_host");
    expect(published.json.error.message).toMatch(/Enterprise Server/);
    expect(github.uploads).toHaveLength(0);
  });

  it("accepts a *.ghe.com remote", async () => {
    const { context } = await finishedRun({ remoteUrl: "git@acme.ghe.com:acme/widgets.git" });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(0);
  });

  it("refuses a run that has not been finished", async () => {
    const repository = createRepository({ branch });
    const app = await startTestServer();
    const context = { cwd: repository.path, home: createHome() };
    await runCli(["start", "--url", app.url], context);

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(2);
    expect(published.json.error.code).toBe("run_not_finished");
  });

  it("explains when gh is not logged in", async () => {
    const { context } = await finishedRun({ ghToken: null });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(2);
    expect(published.json.error.code).toBe("github_auth_missing");
  });
});
