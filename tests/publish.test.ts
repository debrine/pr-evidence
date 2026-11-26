import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
    { description: "The login form appears", result: "pass", screenshots: ["001-login.png"] },
    { description: "Signing in shows the dashboard", result: "pass", screenshots: ["002-dashboard.png"] },
  ],
};

interface RunSetup {
  fakeGitHubOptions?: (headSha: string) => FakeGitHubOptions;
  results?: unknown;
  remoteUrl?: string;
  ghToken?: string | null;
  dirty?: boolean;
  /** Screenshot file names to capture. Defaults to the two the passing results cite. */
  screenshots?: string[];
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
  for (const fileName of setup.screenshots ?? ["001-login.png", "002-dashboard.png"]) {
    writeSolidPng(join(started.json.screenshotDirectory, fileName), [255, 0, 0]);
  }
  const results = writeResults(createTemporaryDirectory(), setup.results ?? passingResults);
  await runCli(["finish", "--results", results], context);
  return { repository, github, context, started: started.json };
}

interface Section {
  title: string;
  collapsed: boolean;
  content: string;
}

/**
 * Finds the comment's sections: a collapsed `<details>`, or an open `###` heading that runs to the
 * next rule. A rule always follows the last section, because the footer starts with one.
 */
function sectionsOf(body: string): Section[] {
  const sectionPattern =
    /<details>\n<summary>(.*)<\/summary>\n([\s\S]*?)\n<\/details>|^### (.*)\n([\s\S]*?)(?=\n\n---\n)/gm;
  return [...body.matchAll(sectionPattern)].map((match) =>
    match[1] !== undefined
      ? { title: match[1], collapsed: true, content: match[2]! }
      : { title: match[3]!, collapsed: false, content: match[4]! },
  );
}

/** The file names of the thumbnails in some comment text, in order. */
function thumbnailNames(content: string): string[] {
  return [...content.matchAll(/<img src="https:[^"]+" height="240" alt="([^"]+)">/g)].map(
    (match) => match[1]!,
  );
}

describe("publish", () => {
  it("uploads every screenshot, and no GIF, with the documented request shape", async () => {
    const { github, context } = await finishedRun();

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(0);
    expect(github.uploads.map((upload) => upload.name).sort()).toEqual([
      "001-login.png",
      "002-dashboard.png",
    ]);
    const screenshot = github.uploads.find((upload) => upload.name === "001-login.png")!;
    expect(screenshot.contentType).toBe("image/png");
    expect(screenshot.repositoryId).toBe("4242");
    expect(screenshot.authorization).toBe("Bearer gho_testtoken");
    expect(screenshot.requestContentType).toBe("application/octet-stream");
    expect(screenshot.accept).toBe("application/vnd.github+json");
    expect(screenshot.size).toBeGreaterThan(0);
  });

  it("posts one comment with the result, commit, ticket, criteria and screenshots", async () => {
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
    expect(body).toContain("1. ✅ Pass: The login form appears");
    expect(thumbnailNames(body)).toEqual(["001-login.png", "002-dashboard.png"]);
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

  it("counts the passed and failed criteria in the header", async () => {
    const { github, context } = await finishedRun({
      results: {
        criteria: [
          { description: "One", result: "pass", screenshots: [] },
          { description: "Two", result: "fail", screenshots: [] },
          { description: "Three", result: "pass", screenshots: [] },
        ],
      },
    });

    await runCli(["publish"], context);

    expect(github.comments[0]!.body).toContain("- **Criteria:** 2 passed, 1 failed\n");
  });

  it("counts zero failures when every criterion passed", async () => {
    const { github, context } = await finishedRun();

    await runCli(["publish"], context);

    expect(github.comments[0]!.body).toContain("- **Criteria:** 2 passed, 0 failed\n");
  });

  it("lists each criterion once, numbered in results order, with no results table", async () => {
    const { github, context } = await finishedRun({
      results: {
        ticket: null,
        criteria: [
          { description: "The login form appears", result: "pass", screenshots: ["001-login.png"] },
          {
            description: "Saving works",
            result: "fail",
            screenshots: ["002-dashboard.png"],
            note: "A 500 error appeared",
          },
          { description: "Signing out works", result: "pass", screenshots: [] },
        ],
      },
    });

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(0);
    const { body } = github.comments[0]!;
    expect(body).toContain("Failed");
    expect(body).toContain("No ticket");
    expect(body).not.toContain("| Result | Criterion |");
    expect(body.match(/Saving works/g)).toHaveLength(1);
    const sections = sectionsOf(body);
    expect(sections.map((section) => section.title)).toEqual([
      "1. ✅ Pass: The login form appears",
      "2. ❌ Fail: Saving works",
      "3. ✅ Pass: Signing out works",
    ]);
    expect(sections.map((section) => section.collapsed)).toEqual([true, false, true]);
    expect(thumbnailNames(sections[0]!.content)).toEqual(["001-login.png"]);
    expect(sections[1]!.content).toMatch(/A 500 error appeared\n\n<img /);
    expect(thumbnailNames(sections[1]!.content)).toEqual(["002-dashboard.png"]);
    expect(sections[2]!.content).toContain("No screenshots");
    expect(sections[2]!.content).not.toContain("<img");
  });

  it("separates each criterion from the next with a rule, and puts none before the first", async () => {
    const { github, context } = await finishedRun({
      screenshots: [],
      results: {
        criteria: [
          { description: "One", result: "pass", screenshots: [] },
          { description: "Two", result: "fail", screenshots: [] },
          { description: "Three", result: "pass", screenshots: [] },
        ],
      },
    });

    await runCli(["publish"], context);

    // A blank line before each rule keeps it from turning the line above into a heading.
    const [head, ...blocks] = github.comments[0]!.body.split("\n\n---\n\n");
    expect(head).toMatch(/\n\n<details>\n<summary>1\. ✅ Pass: One<\/summary>\n[\s\S]*<\/details>$/);
    expect(head!.match(/<details>/g)).toHaveLength(1);
    expect(blocks.map((block) => block.split("\n")[0])).toEqual([
      "### 2. ❌ Fail: Two",
      "<details>",
      expect.stringContaining("Want to try it yourself?"),
    ]);
    expect(blocks[1]).toMatch(/^<details>\n<summary>3\. ✅ Pass: Three<\/summary>\n[\s\S]*<\/details>$/);
  });

  it("shows a criterion's screenshots as same-height thumbnails side by side on one line", async () => {
    const { github, context } = await finishedRun({
      results: {
        criteria: [
          {
            description: "Signing in shows the dashboard",
            result: "pass",
            screenshots: ["001-login.png", "002-dashboard.png"],
          },
        ],
      },
    });

    await runCli(["publish"], context);

    // A height with no width caps the height and keeps the aspect ratio. GitHub links each image to its full size.
    const thumbnail = (fileName: string) =>
      `<img src="https://github\\.com/user-attachments/assets/[0-9a-f-]+" height="240" alt="${fileName.replaceAll(".", "\\.")}">`;
    const [section] = sectionsOf(github.comments[0]!.body);
    expect(section!.content).toMatch(
      new RegExp(`\\n${thumbnail("001-login.png")} ${thumbnail("002-dashboard.png")}\\n`),
    );
    expect(github.comments[0]!.body).not.toContain("width=");
  });

  it("shows a criterion's screenshots in listed order and keeps uncited ones in one collapsed section", async () => {
    const { github, context } = await finishedRun({
      screenshots: ["001-setup.png", "002-form.png", "003-saving.png", "004-saved.png", "005-teardown.png"],
      results: {
        criteria: [
          {
            description: "Saving shows progress, then the note",
            result: "fail",
            screenshots: ["004-saved.png", "003-saving.png"],
          },
          { description: "The saved note is listed", result: "pass", screenshots: ["004-saved.png"] },
        ],
      },
    });

    await runCli(["publish"], context);

    const { body } = github.comments[0]!;
    const sections = sectionsOf(body);
    expect(sections.map((section) => section.title)).toEqual([
      "1. ❌ Fail: Saving shows progress, then the note",
      "2. ✅ Pass: The saved note is listed",
      "Other screenshots (3)",
    ]);
    expect(thumbnailNames(sections[0]!.content)).toEqual(["004-saved.png", "003-saving.png"]);
    expect(thumbnailNames(sections[1]!.content)).toEqual(["004-saved.png"]);
    expect(sections[2]!.collapsed).toBe(true);
    expect(thumbnailNames(sections[2]!.content)).toEqual(["001-setup.png", "002-form.png", "005-teardown.png"]);
    expect(thumbnailNames(body).filter((name) => name === "003-saving.png")).toHaveLength(1);
  });

  it("leaves out the other screenshots section when every screenshot is cited", async () => {
    const { github, context } = await finishedRun();

    await runCli(["publish"], context);

    expect(github.comments[0]!.body).not.toContain("Other screenshots");
  });

  it("keeps criterion text and file names from breaking the layout or injecting markup", async () => {
    const hostileFileName = 'a"b<c>&d.png';
    const { github, context } = await finishedRun({
      screenshots: [hostileFileName, "002-uncited <b>.png"],
      results: {
        criteria: [
          {
            description: "a | b\nc <img src=x>",
            result: "pass",
            screenshots: [hostileFileName],
            note: "x | y <script>",
          },
        ],
      },
    });

    await runCli(["publish"], context);

    const { body } = github.comments[0]!;
    // GitHub shows a backslash escape literally inside <summary>, so a pipe stays as typed.
    expect(body).toContain("<summary>1. ✅ Pass: a | b c &lt;img src=x&gt;</summary>");
    expect(body).toContain("x | y &lt;script&gt;");
    expect(body).toMatch(/<img src="https:[^"]+" height="240" alt="a&quot;b&lt;c&gt;&amp;d\.png">/);
    expect(body).toMatch(/\*\*002-uncited &lt;b&gt;\.png\*\*\n\n<img src="https:[^"]+" height="240" alt="002-uncited &lt;b&gt;\.png">/);
    expect(body).not.toContain("<img src=x>");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<b>");
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

  it("publishes the checked-out commit's run even when a later run exists on another branch", async () => {
    const { repository, github, context } = await finishedRun({
      fakeGitHubOptions: (headSha) => ({ pullRequests: [{ number: 7, branch, headSha }] }),
    });
    const app = await startTestServer();
    git(repository.path, "checkout", "-q", "-b", "other-work");
    git(repository.path, "commit", "-q", "--allow-empty", "-m", "other work");
    await runCli(["start", "--url", app.url], context);
    git(repository.path, "checkout", "-q", branch);

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(0);
    expect(published.json.pullRequest.number).toBe(7);
    expect(github.comments[0]!.body).toContain(repository.headSha);
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
    expect(existsSync(join(started.screenshotDirectory, "001-login.png"))).toBe(true);
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

  it("refuses a run finished by an earlier version, before any upload", async () => {
    const { github, context, started } = await finishedRun();
    const recordPath = join(started.runDirectory, "run.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.outcome.criteria = [{ description: "The login form appears", result: "pass", screenshot: "001-login.png" }];
    record.outcome.gifPath = null;
    writeFileSync(recordPath, JSON.stringify(record));

    const published = await runCli(["publish"], context);

    expect(published.exitCode).toBe(2);
    expect(published.json.error.code).toBe("run_outdated");
    expect(published.json.error.message).toMatch(/run it again/i);
    expect(github.uploads).toHaveLength(0);
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
