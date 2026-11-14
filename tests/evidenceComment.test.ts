import { describe, expect, it } from "vitest";
import { renderEvidenceComment } from "../src/evidenceComment.js";

function renderWithBranch(branch: string | null): string {
  const repository = { host: "github.com", owner: "acme", name: "widgets" };
  return renderEvidenceComment({
    repository,
    record: {
      rootPath: "/repository",
      repository,
      repositoryKey: "remote-test",
      sha: "a".repeat(40),
      branch,
      dirty: false,
      url: "http://localhost:3000",
      createdAt: "2026-11-06T00:00:00Z",
    },
    outcome: { result: "pass", ticket: null, criteria: [], screenshots: [] },
    screenshotUrls: new Map(),
    headDiffers: false,
  });
}

describe("evidence comment comparison links", () => {
  it.each([
    ["feature/#123", "feature%2F%23123"],
    ["feature/(login)", "feature%2F%28login%29"],
    ["feature/#123(login)", "feature%2F%23123%28login%29"],
    ["feature/login", "feature%2Flogin"],
  ])("preserves branch %s in a Markdown link destination", (branch, encodedBranch) => {
    const comment = renderWithBranch(branch);
    const destination = /\[compare with the branch\]\(([^()]*)\)/.exec(comment)?.[1];

    expect(destination).toBe(
      `https://github.com/acme/widgets/compare/${"a".repeat(40)}...${encodedBranch}`,
    );
    const url = new URL(destination!);
    expect(url.hash).toBe("");
    expect(decodeURIComponent(url.pathname.split("...")[1]!)).toBe(branch);
  });

  it("omits the comparison link for a detached commit", () => {
    expect(renderWithBranch(null)).not.toContain("[compare with the branch]");
  });
});
