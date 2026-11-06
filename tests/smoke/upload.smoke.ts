import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GitHubClient, readUploadToken, uploadsBaseUrl } from "../../src/github.js";
import { parseRemoteUrl } from "../../src/repoState.js";
import { GitHubAttachmentUploader } from "../../src/uploader.js";
import { writeSolidPng } from "../support/fixtures.js";

it("uploads to the real endpoint and the bytes come back", async () => {
  const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const repository = parseRemoteUrl(remoteUrl)!;
  const token = readUploadToken(repository.host);
  const { repositoryId } = await new GitHubClient(repository, token).readRepositoryAccess();
  const filePath = join(mkdtempSync(join(tmpdir(), "pr-evidence-smoke-")), "smoke.png");
  writeSolidPng(filePath, [0, 128, 255], 2, 2);

  const url = await new GitHubAttachmentUploader({
    uploadsBaseUrl: uploadsBaseUrl(repository.host),
    token,
    repositoryId,
    host: repository.host,
  }).upload(filePath);

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(filePath));
});
