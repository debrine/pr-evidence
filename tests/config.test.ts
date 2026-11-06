import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHome, createRepository, git, runCli, startTestServer } from "./support/harness.js";

function commitConfig(repositoryPath: string, content: string): void {
  writeFileSync(join(repositoryPath, ".pr-evidence.yml"), content);
  git(repositoryPath, "add", ".");
  git(repositoryPath, "commit", "-q", "-m", "add config");
}

describe(".pr-evidence.yml", () => {
  it("reports a missing config when no --url is given, so the agent can offer to draft one", async () => {
    const repository = createRepository();

    const result = await runCli(["start"], { cwd: repository.path, home: createHome() });

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("config_missing");
  });

  it.each([
    ["invalid YAML", "start: [", /\.pr-evidence\.yml/],
    ["a missing ready URL", "start: npm run dev\n", /readyUrl/],
    ["a missing start command", "readyUrl: http://localhost:3000\n", /start/],
    ["a malformed ready URL", "start: x\nreadyUrl: not a url\n", /readyUrl/],
    ["an unknown key", "start: x\nreadyUrl: http://localhost:3000\ncriteria: []\n", /criteria/],
    ["login that is not env var names", "start: x\nreadyUrl: http://localhost:3000\nlogin:\n  usernameEnv: 1\n", /usernameEnv/],
  ])("explains %s", async (_name, content, expectedMessage) => {
    const repository = createRepository();
    commitConfig(repository.path, content);

    const result = await runCli(["start"], { cwd: repository.path, home: createHome() });

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("config_invalid");
    expect(result.json.error.message).toMatch(expectedMessage);
  });

  it("is ignored for starting the app when --url overrides it, but still supplies login and tickets", async () => {
    const repository = createRepository();
    commitConfig(
      repository.path,
      [
        "start: exit 1",
        "readyUrl: http://127.0.0.1:9/",
        "login:",
        "  usernameEnv: APP_TEST_USER",
        "  passwordEnv: APP_TEST_PASSWORD",
        "ticketFolder: docs/tickets",
        "",
      ].join("\n"),
    );
    const app = await startTestServer();

    const result = await runCli(["start", "--url", app.url], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.url).toBe(app.url);
    expect(result.json.login).toEqual({
      usernameEnv: "APP_TEST_USER",
      passwordEnv: "APP_TEST_PASSWORD",
    });
    expect(result.json.ticketFolder).toBe("docs/tickets");
  });
});
