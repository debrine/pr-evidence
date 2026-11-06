import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";

export interface RecordedUpload {
  name: string;
  contentType: string;
  repositoryId: string;
  authorization: string;
  requestContentType: string;
  accept: string;
  size: number;
}

interface FakeComment {
  id: number;
  body: string;
  user: { login: string };
}

export interface FakeGitHubOptions {
  viewerLogin?: string;
  viewerPermission?: string;
  repositoryId?: number;
  pullRequests?: { number: number; branch: string; headSha: string; owner?: string }[];
  /** Commits GitHub has besides the PR heads. */
  commits?: string[];
  commitLookupStatus?: number;
  comments?: FakeComment[];
  uploadResponse?: (name: string, uploadCount: number) => { status: number; body: string } | null;
}

export interface FakeGitHub {
  baseUrl: string;
  uploads: RecordedUpload[];
  comments: FakeComment[];
  commentWrites: { method: string; path: string }[];
}

const openServers: { close: (done: () => void) => void }[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((server) => new Promise<void>((closed) => server.close(closed))),
  );
});

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** One local server standing in for api.github.com and uploads.github.com. */
export async function startFakeGitHub(options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const uploads: RecordedUpload[] = [];
  const comments = [...(options.comments ?? [])];
  const commentWrites: FakeGitHub["commentWrites"] = [];
  const viewerLogin = options.viewerLogin ?? "tester";
  let nextCommentId = 1000;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fake");
    const body = await readBody(request);

    if (url.pathname === "/graphql") {
      sendJson(response, 200, {
        data: {
          viewer: { login: viewerLogin },
          repository: {
            databaseId: options.repositoryId ?? 4242,
            viewerPermission: options.viewerPermission ?? "WRITE",
          },
        },
      });
      return;
    }

    if (url.pathname === "/user-attachments/assets" && request.method === "POST") {
      const name = url.searchParams.get("name")!;
      uploads.push({
        name,
        contentType: url.searchParams.get("content_type")!,
        repositoryId: url.searchParams.get("repository_id")!,
        authorization: request.headers.authorization ?? "",
        requestContentType: request.headers["content-type"] ?? "",
        accept: request.headers.accept ?? "",
        size: body.length,
      });
      const override = options.uploadResponse?.(name, uploads.length);
      if (override) {
        response.writeHead(override.status);
        response.end(override.body);
        return;
      }
      sendJson(response, 201, { url: `https://github.com/user-attachments/assets/${randomUUID()}` });
      return;
    }

    const pullsMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (pullsMatch && request.method === "GET") {
      const head = url.searchParams.get("head");
      const matching = (options.pullRequests ?? []).filter(
        (pullRequest) => `${pullRequest.owner ?? pullsMatch[1]}:${pullRequest.branch}` === head,
      );
      sendJson(
        response,
        200,
        matching.map((pullRequest) => ({
          number: pullRequest.number,
          html_url: `https://github.com/${pullsMatch[1]}/${pullsMatch[2]}/pull/${pullRequest.number}`,
          head: { sha: pullRequest.headSha },
        })),
      );
      return;
    }

    const commitMatch = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)$/.exec(url.pathname);
    if (commitMatch && request.method === "GET") {
      const sha = commitMatch[1]!;
      const knownCommits = [
        ...(options.commits ?? []),
        ...(options.pullRequests ?? []).map((pullRequest) => pullRequest.headSha),
      ];
      if (options.commitLookupStatus !== undefined) {
        sendJson(response, options.commitLookupStatus, { message: "Lookup failed" });
      } else if (knownCommits.includes(sha)) {
        sendJson(response, 200, { sha });
      } else {
        sendJson(response, 422, { message: `No commit found for SHA: ${sha}` });
      }
      return;
    }

    const commentsMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.exec(url.pathname);
    if (commentsMatch && request.method === "GET") {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      sendJson(response, 200, comments.slice((page - 1) * perPage, page * perPage));
      return;
    }
    if (commentsMatch && request.method === "POST") {
      commentWrites.push({ method: "POST", path: url.pathname });
      const comment = {
        id: nextCommentId++,
        body: JSON.parse(body.toString()).body,
        user: { login: viewerLogin },
      };
      comments.push(comment);
      sendJson(response, 201, { ...comment, html_url: `https://github.com/comment/${comment.id}` });
      return;
    }

    const commentMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(url.pathname);
    if (commentMatch && request.method === "PATCH") {
      commentWrites.push({ method: "PATCH", path: url.pathname });
      const comment = comments.find((candidate) => candidate.id === Number(commentMatch[1]))!;
      comment.body = JSON.parse(body.toString()).body;
      sendJson(response, 200, { ...comment, html_url: `https://github.com/comment/${comment.id}` });
      return;
    }

    sendJson(response, 404, { message: `Not handled: ${request.method} ${url.pathname}` });
  });
  openServers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, uploads, comments, commentWrites };
}
