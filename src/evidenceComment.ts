import type { CriterionResult, RunOutcome, RunRecord } from "./evidenceStore.js";
import type { RepositoryIdentity } from "./repoState.js";

export const commentMarker = "<!-- pr-evidence -->";

const npmPackageUrl = "https://www.npmjs.com/package/pr-evidence";

/**
 * Every screenshot shows at this height, so an open criterion fits on about one screen. GitHub turns
 * a height with no width into a maximum height that keeps the aspect ratio, and links each image to
 * its full size.
 */
const thumbnailHeight = 240;

export interface EvidenceCommentInput {
  repository: RepositoryIdentity;
  record: RunRecord;
  outcome: RunOutcome;
  /** Hosted URL for each uploaded file, by file name. */
  screenshotUrls: Map<string, string>;
  headDiffers: boolean;
}

/** Makes untrusted text safe for one line of Markdown, such as a heading or a `<summary>`. */
function escapeInline(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replace(/\s*\n\s*/g, " ");
}

/** Makes untrusted text safe inside a double-quoted HTML attribute. */
function escapeAttribute(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Encodes a branch name as one URL path segment that is also safe in a Markdown link destination. */
function encodeBranchForLink(branch: string): string {
  return encodeURIComponent(branch).replaceAll("(", "%28").replaceAll(")", "%29");
}

function thumbnail(fileName: string, url: string): string {
  const source = escapeAttribute(url);
  return `<img src="${source}" height="${thumbnailHeight}" alt="${escapeAttribute(fileName)}">`;
}

/** One line of thumbnails, so they sit side by side and wrap to the comment's width. */
function thumbnailRow(fileNames: string[], screenshotUrls: Map<string, string>): string {
  return fileNames.map((fileName) => thumbnail(fileName, screenshotUrls.get(fileName)!)).join(" ");
}

function renderSummary(input: EvidenceCommentInput): string[] {
  const { repository, record, outcome } = input;
  const repositoryUrl = `https://${repository.host}/${repository.owner}/${repository.name}`;
  const passedCount = outcome.criteria.filter((criterion) => criterion.result === "pass").length;
  const failedCount = outcome.criteria.length - passedCount;
  const lines = [
    `## PR evidence: ${outcome.result === "pass" ? "Passed" : "Failed"}`,
    "",
    `- **Tested commit:** [${record.sha}](${repositoryUrl}/commit/${record.sha})`,
    `- **Ticket:** ${outcome.ticket === null ? "No ticket" : escapeInline(outcome.ticket)}`,
    `- **Criteria:** ${passedCount} passed, ${failedCount} failed`,
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

/** The number, icon and word together, so the result reads anywhere the emoji does not render. */
function criterionTitle(criterion: CriterionResult, number: number): string {
  const result = criterion.result === "pass" ? "✅ Pass" : "❌ Fail";
  return `${number}. ${result}: ${escapeInline(criterion.description)}`;
}

function renderProof(criterion: CriterionResult, screenshotUrls: Map<string, string>): string[] {
  const note = criterion.note ? ["", escapeInline(criterion.note)] : [];
  const screenshots =
    criterion.screenshots.length === 0
      ? "No screenshots"
      : thumbnailRow(criterion.screenshots, screenshotUrls);
  return [...note, "", screenshots];
}

/** Failures are expanded so the proof to act on is visible; passes stay one click away. */
function renderCriterionSection(
  criterion: CriterionResult,
  number: number,
  screenshotUrls: Map<string, string>,
): string[] {
  const title = criterionTitle(criterion, number);
  const proof = renderProof(criterion, screenshotUrls);
  return criterion.result === "fail"
    ? [`### ${title}`, ...proof]
    : ["<details>", `<summary>${title}</summary>`, ...proof, "", "</details>"];
}

/** Screenshots no criterion cites, such as setup steps, kept out of the way. */
function renderOtherScreenshots({ outcome, screenshotUrls }: EvidenceCommentInput): string[] | null {
  const cited = new Set(outcome.criteria.flatMap((criterion) => criterion.screenshots));
  const others = outcome.screenshots.filter((fileName) => !cited.has(fileName));
  if (others.length === 0) {
    return null;
  }
  return [
    "<details>",
    `<summary>Other screenshots (${others.length})</summary>`,
    ...others.flatMap((fileName) => [
      "",
      `**${escapeInline(fileName)}**`,
      "",
      thumbnail(fileName, screenshotUrls.get(fileName)!),
    ]),
    "",
    "</details>",
  ];
}

/** A small plug so reviewers who like the comment can find the tool. */
function renderFooter(): string[] {
  return [
    "",
    "---",
    "",
    `<sub>Want to try it yourself? Check out [pr-evidence on npm](${npmPackageUrl}).</sub>`,
  ];
}

/**
 * Puts a rule between sections, so many criteria never blur together. The blank line before each
 * rule stops it turning the line above into a heading.
 */
function joinWithRules(sections: string[][]): string[] {
  return sections.flatMap((section, index) => [
    ...(index === 0 ? [] : ["", "---"]),
    "",
    ...section,
  ]);
}

export function renderEvidenceComment(input: EvidenceCommentInput): string {
  const criterionSections = input.outcome.criteria.map((criterion, index) =>
    renderCriterionSection(criterion, index + 1, input.screenshotUrls),
  );
  const otherScreenshots = renderOtherScreenshots(input);
  const sections =
    otherScreenshots === null ? criterionSections : [...criterionSections, otherScreenshots];
  return [
    commentMarker,
    ...renderSummary(input),
    ...joinWithRules(sections),
    ...renderFooter(),
    "",
  ].join("\n");
}
