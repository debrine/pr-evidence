import type { RunOutcome, RunRecord } from "./evidenceStore.js";
import type { RepositoryIdentity } from "./repoState.js";

export const commentMarker = "<!-- pr-evidence -->";

export interface EvidenceCommentInput {
  repository: RepositoryIdentity;
  record: RunRecord;
  outcome: RunOutcome;
  /** Hosted URL for each uploaded file, by file name. */
  screenshotUrls: Map<string, string>;
  gifUrl: string | null;
  headDiffers: boolean;
}

/** Makes untrusted text safe for one line of Markdown, including inside a table cell. */
function escapeInline(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replace(/\s*\n\s*/g, " ");
}

/** Encodes a branch name as one URL path segment that is also safe in a Markdown link destination. */
function encodeBranchForLink(branch: string): string {
  return encodeURIComponent(branch).replaceAll("(", "%28").replaceAll(")", "%29");
}

function image(fileName: string, url: string): string {
  return `![${escapeInline(fileName)}](${url})`;
}

function renderSummary(input: EvidenceCommentInput): string[] {
  const { repository, record, outcome } = input;
  const repositoryUrl = `https://${repository.host}/${repository.owner}/${repository.name}`;
  const lines = [
    `## PR evidence: ${outcome.result === "pass" ? "Passed" : "Failed"}`,
    "",
    `- **Tested commit:** [${record.sha}](${repositoryUrl}/commit/${record.sha})`,
    `- **Ticket:** ${outcome.ticket === null ? "No ticket" : escapeInline(outcome.ticket)}`,
  ];
  if (record.branch !== null) {
    lines.push(
      `- **Later changes:** [compare with the branch](${repositoryUrl}/compare/${record.sha}...${encodeBranchForLink(record.branch)})`,
    );
  }
  if (record.dirty) {
    lines.push(
      "",
      "> [!WARNING]",
      "> This run included uncommitted changes, so it does not exactly show the commit above.",
    );
  }
  if (input.headDiffers) {
    lines.push(
      "",
      "> [!WARNING]",
      "> The PR head differs from the tested commit.",
    );
  }
  return lines;
}

function renderCriteria(outcome: RunOutcome): string[] {
  return [
    "",
    "| Result | Criterion | Note |",
    "| --- | --- | --- |",
    ...outcome.criteria.map(
      (criterion) =>
        `| ${criterion.result === "pass" ? "Pass" : "Fail"} | ${escapeInline(criterion.description)} | ${escapeInline(criterion.note ?? "")} |`,
    ),
  ];
}

function renderFailures({ outcome, screenshotUrls }: EvidenceCommentInput): string[] {
  return outcome.criteria.flatMap((criterion) => {
    const url = criterion.screenshot && screenshotUrls.get(criterion.screenshot);
    return criterion.result === "fail" && url
      ? ["", `**Failed: ${escapeInline(criterion.description)}**`, "", image(criterion.screenshot!, url)]
      : [];
  });
}

function renderScreenshots({ outcome, screenshotUrls }: EvidenceCommentInput): string[] {
  if (outcome.screenshots.length === 0) {
    return [];
  }
  return [
    "",
    "<details>",
    `<summary>Screenshots (${outcome.screenshots.length})</summary>`,
    ...outcome.screenshots.flatMap((fileName) => [
      "",
      `**${escapeInline(fileName)}**`,
      "",
      image(fileName, screenshotUrls.get(fileName)!),
    ]),
    "",
    "</details>",
  ];
}

export function renderEvidenceComment(input: EvidenceCommentInput): string {
  return [
    commentMarker,
    ...renderSummary(input),
    ...renderCriteria(input.outcome),
    ...renderFailures(input),
    ...(input.gifUrl === null ? [] : ["", `![Step-by-step run](${input.gifUrl})`]),
    ...renderScreenshots(input),
    "",
  ].join("\n");
}
