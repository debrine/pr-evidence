import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHome,
  createRepository,
  git,
  runCli,
  runCliForOutput,
  startTestServer,
  type CliOptions,
} from "./support/harness.js";

const fakeBrowserPath = resolve("tests/support/fakeBrowser.mjs");

interface FakeBrowserCall {
  args: string[];
  env: Record<string, string | undefined>;
}

async function runBrowser(args: string[], options: Partial<CliOptions> = {}) {
  const output = await runCliForOutput(["browser", ...args], {
    cwd: options.cwd ?? createRepository().path,
    home: options.home ?? createHome(),
    ...options,
    env: { PR_EVIDENCE_BROWSER_CLI_PATH: fakeBrowserPath, ...options.env },
  });
  return { ...output, call: () => JSON.parse(output.stdout) as FakeBrowserCall };
}

describe("browser", () => {
  it("passes its arguments to the browser CLI exactly as written, with no shell in between", async () => {
    const args = ["fill", "@3", "a&b", "%PATH%", 'say "hi"', "it's", "$HOME", "`id`", "two words", ""];

    const result = await runBrowser(args);

    expect(result.exitCode).toBe(0);
    expect(result.call().args).toEqual(args);
  });

  it("isolates the browser on this repo's dedicated profile and session, never the developer's own Chrome", async () => {
    const repository = createRepository();
    const home = createHome();
    const app = await startTestServer();
    const developerBrowserSettings = {
      CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "1",
      CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222",
      CHROME_DEVTOOLS_AXI_MCP_SERVER_URL: "http://127.0.0.1:9333",
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/home/developer/chrome",
      CHROME_DEVTOOLS_AXI_SESSION: "developer",
    };
    const sessionNow = async () =>
      (await runBrowser(["snapshot"], { cwd: repository.path, home })).call().env.CHROME_DEVTOOLS_AXI_SESSION;

    const started = await runCli(["start", "--url", app.url], { cwd: repository.path, home });
    const { env } = (
      await runBrowser(["snapshot"], { cwd: repository.path, home, env: developerBrowserSettings })
    ).call();

    expect(env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT).toBeUndefined();
    expect(env.CHROME_DEVTOOLS_AXI_BROWSER_URL).toBeUndefined();
    expect(env.CHROME_DEVTOOLS_AXI_MCP_SERVER_URL).toBeUndefined();
    expect(env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR).toBe(started.json.browser.profileDirectory);
    const session = env.CHROME_DEVTOOLS_AXI_SESSION;
    expect(session).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(await sessionNow()).toBe(session);
    git(repository.path, "remote", "set-url", "origin", "git@github.com:acme/other.git");
    expect(await sessionNow()).not.toBe(session);
  });

  it("shows the browser window only when --headed comes before the browser CLI's own arguments", async () => {
    const headed = (await runBrowser(["--headed", "open", "http://localhost:3000"])).call();
    const headless = (await runBrowser(["open", "http://localhost:3000", "--headed"])).call();

    expect(headed.env.CHROME_DEVTOOLS_AXI_HEADED).toBe("1");
    expect(headed.args).toEqual(["open", "http://localhost:3000"]);
    expect(headless.env.CHROME_DEVTOOLS_AXI_HEADED).toBeUndefined();
    expect(headless.args).toEqual(["open", "http://localhost:3000", "--headed"]);
  });

  it("gives back the browser CLI's own stdout, stderr and exit code, not the helper's JSON", async () => {
    const result = await runBrowser(["click", "@9"], { env: { FAKE_BROWSER_EXIT_CODE: "3" } });

    expect(result.exitCode).toBe(3);
    expect(result.call().args).toEqual(["click", "@9"]);
    expect(result.stderr).toBe("fake browser stderr\n");
  });
});
