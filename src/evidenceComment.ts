import type { CriterionResult, RunOutcome, RunRecord } from "./evidenceStore.js";
import type { RepositoryIdentity } from "./repoState.js";

export const commentMarker = "<!-- pr-evidence -->";

export interface EvidenceCommentInput {
  repository: RepositoryIdentity;
  record: RunRecord;
  outcome: RunOutcome;
  /** Hosted URL for each uploaded file, by file name. */
  screenshotUrls: Map<string, string>;
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

function resultLabel(criterion: CriterionResult): string {
  return criterion.result === "pass" ? "Pass" : "Fail";
}

function renderTable(outcome: RunOutcome): string[] {
  return [
    "",
    "| Result | Criterion |",
    "| --- | --- |",
    ...outcome.criteria.map(
      (criterion) => `| ${resultLabel(criterion)} | ${escapeInline(criterion.description)} |`,
    ),
  ];
}

function renderProof(criterion: CriterionResult, screenshotUrls: Map<string, string>): string[] {
  const note = criterion.note ? ["", escapeInline(criterion.note)] : [];
  const images =
    criterion.screenshots.length === 0
      ? ["", "No screenshots"]
      : criterion.screenshots.flatMap((fileName) => [
          "",
          image(fileName, screenshotUrls.get(fileName)!),
        ]);
  return [...note, ...images];
}

/** Failures are expanded so the proof to act on is visible; passes stay one click away. */
function renderCriterionSection(
  criterion: CriterionResult,
  screenshotUrls: Map<string, string>,
): string[] {
  const title = `${resultLabel(criterion)}: ${escapeInline(criterion.description)}`;
  const proof = renderProof(criterion, screenshotUrls);
  return criterion.result === "fail"
    ? ["", `### ${title}`, ...proof]
    : ["", "<details>", `<summary>${title}</summary>`, ...proof, "", "</details>"];
}

/** Screenshots no criterion cites, such as setup steps, kept out of the way. */
function renderOtherScreenshots({ outcome, screenshotUrls }: EvidenceCommentInput): string[] {
  const cited = new Set(outcome.criteria.flatMap((criterion) => criterion.screenshots));
  const others = outcome.screenshots.filter((fileName) => !cited.has(fileName));
  if (others.length === 0) {
    return [];
  }
  return [
    "",
    "<details>",
    `<summary>Other screenshots (${others.length})</summary>`,
    ...others.flatMap((fileName) => [
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
    ...renderTable(input.outcome),
    ...input.outcome.criteria.flatMap((criterion) =>
      renderCriterionSection(criterion, input.screenshotUrls),
    ),
    ...renderOtherScreenshots(input),
    "",
  ].join("\n");
}
