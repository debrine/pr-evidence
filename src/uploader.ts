import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { CliError } from "./errors.js";

/** Stores one local file somewhere a PR comment can link to, and returns that link. */
export interface Uploader {
  upload(filePath: string): Promise<string>;
}

export const imageLimitBytes = 10 * 1024 * 1024;
const uploadTimeoutMilliseconds = 60_000;
const attachmentPath =
  /^\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const contentTypes: Record<string, string> = {
  ".png": "image/png",
  ".gif": "image/gif",
};

function failed(filePath: string, problem: string): CliError {
  return new CliError("upload_failed", `Could not upload ${basename(filePath)}: ${problem}`);
}

/**
 * Uploads through the endpoint behind GitHub's comment box. GitHub does not
 * document it. The contract follows no-mistakes (MIT), which follows gh.
 * Every failure throws, so a bad response can never become a dead link.
 */
export class GitHubAttachmentUploader implements Uploader {
  constructor(
    private readonly options: {
      uploadsBaseUrl: string;
      token: string;
      repositoryId: number;
      host: string;
    },
  ) {}

  async upload(filePath: string): Promise<string> {
    const contentType = contentTypes[extname(filePath).toLowerCase()];
    if (contentType === undefined) {
      throw failed(filePath, "unsupported file type.");
    }
    const { size } = statSync(filePath);
    if (size === 0 || size > imageLimitBytes) {
      throw failed(filePath, `size ${size} is outside the allowed range.`);
    }

    const query = new URLSearchParams({
      name: basename(filePath),
      content_type: contentType,
      repository_id: String(this.options.repositoryId),
    });
    let response: Response;
    try {
      response = await fetch(`${this.options.uploadsBaseUrl}/user-attachments/assets?${query}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/octet-stream",
          Accept: "application/vnd.github+json",
        },
        body: readFileSync(filePath),
        // A redirect would forward the token to wherever it points.
        redirect: "manual",
        signal: AbortSignal.timeout(uploadTimeoutMilliseconds),
      });
    } catch (cause) {
      throw failed(filePath, String(cause));
    }
    if (!response.ok) {
      throw failed(filePath, `GitHub returned ${response.status}.`);
    }
    return this.parseAttachmentUrl(filePath, await response.text());
  }

  private parseAttachmentUrl(filePath: string, responseBody: string): string {
    let attachmentUrl: URL;
    try {
      attachmentUrl = new URL((JSON.parse(responseBody) as { url: string }).url);
    } catch {
      throw failed(filePath, "GitHub's response had no usable URL.");
    }
    const hostIsExpected =
      attachmentUrl.hostname === "github.com" || attachmentUrl.hostname === this.options.host;
    if (
      attachmentUrl.protocol !== "https:" ||
      !hostIsExpected ||
      !attachmentPath.test(attachmentUrl.pathname)
    ) {
      throw failed(filePath, "GitHub's response was not an attachment URL.");
    }
    return `${attachmentUrl.origin}${attachmentUrl.pathname}`;
  }
}
