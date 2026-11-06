import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHome,
  createRepository,
  createTemporaryDirectory,
  createToolShims,
  runCli,
  startTestServer,
} from "./support/harness.js";

const helperVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
const skillPaths = {
  claude: [".claude", "skills", "pr-evidence", "SKILL.md"],
  codex: [".agents", "skills", "pr-evidence", "SKILL.md"],
  cursor: [".cursor", "skills", "pr-evidence", "SKILL.md"],
};

function homeWithAgents(...agentDirectories: string[]): string {
  const home = createHome();
  for (const directory of agentDirectories) {
    mkdirSync(join(home, directory), { recursive: true });
  }
  return home;
}

describe("setup", () => {
  it("installs the skill for every agent it finds, and only those", async () => {
    const home = homeWithAgents(".claude", ".codex");

    const result = await runCli(["setup"], { cwd: createTemporaryDirectory(), home });

    expect(result.exitCode).toBe(0);
    expect(result.json.installed.map((entry: { agent: string }) => entry.agent)).toEqual([
      "claude",
      "codex",
    ]);
    expect(existsSync(join(home, ...skillPaths.claude))).toBe(true);
    expect(existsSync(join(home, ...skillPaths.codex))).toBe(true);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  it("installs for a named agent even when it was not detected", async () => {
    const home = homeWithAgents();

    const result = await runCli(["setup", "--agent", "cursor"], {
      cwd: createTemporaryDirectory(),
      home,
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, ...skillPaths.cursor))).toBe(true);
  });

  it("writes a skill with valid frontmatter that carries the helper version", async () => {
    const home = homeWithAgents(".claude");

    await runCli(["setup"], { cwd: createTemporaryDirectory(), home });

    const skill = readFileSync(join(home, ...skillPaths.claude), "utf8");
    expect(skill).toMatch(/^---\nname: pr-evidence\ndescription: .+\n---\n/);
    expect(skill).toContain(`--skill-version ${helperVersion}`);
    expect(skill).not.toContain("{{");
  });

  it("replaces an older copy of the skill", async () => {
    const home = homeWithAgents(".claude");
    const skillPath = join(home, ...skillPaths.claude);
    mkdirSync(join(skillPath, ".."), { recursive: true });
    writeFileSync(skillPath, "old");

    await runCli(["setup"], { cwd: createTemporaryDirectory(), home });

    expect(readFileSync(skillPath, "utf8")).not.toBe("old");
  });

  it("fails clearly when no agent is found", async () => {
    const result = await runCli(["setup"], {
      cwd: createTemporaryDirectory(),
      home: homeWithAgents(),
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("no_agent_found");
  });

  it("rejects an unknown agent", async () => {
    const result = await runCli(["setup", "--agent", "emacs"], {
      cwd: createTemporaryDirectory(),
      home: homeWithAgents(),
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("usage");
  });

  it("reports ready when the prerequisites are present", async () => {
    const result = await runCli(["setup"], {
      cwd: createTemporaryDirectory(),
      home: homeWithAgents(".claude"),
    });

    expect(result.json.ready).toBe(true);
    expect(result.json.missingPrerequisites).toEqual([]);
  });

  it("names each missing prerequisite and how to fix it", async () => {
    const result = await runCli(["setup"], {
      cwd: createTemporaryDirectory(),
      home: homeWithAgents(".claude"),
      toolShims: createToolShims({ ghToken: null, browserCli: false }),
    });

    expect(result.json.ready).toBe(false);
    expect(result.json.missingPrerequisites).toEqual([
      expect.objectContaining({ name: "gh", fix: expect.stringContaining("gh auth login") }),
      expect.objectContaining({
        name: "chrome-devtools-axi",
        fix: expect.stringContaining("npm install -g chrome-devtools-axi"),
      }),
    ]);
    expect(result.stderr).toContain("chrome-devtools-axi");
  });
});

describe("start, for the agent", () => {
  it("refuses to start without the browser tool", async () => {
    const repository = createRepository();
    const app = await startTestServer();

    const result = await runCli(["start", "--url", app.url], {
      cwd: repository.path,
      home: createHome(),
      toolShims: createToolShims({ browserCli: false }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("missing_prerequisite");
    expect(result.json.error.message).toContain("chrome-devtools-axi");
  });

  it("warns, without failing, when gh is missing", async () => {
    const repository = createRepository();
    const app = await startTestServer();

    const result = await runCli(["start", "--url", app.url], {
      cwd: repository.path,
      home: createHome(),
      toolShims: createToolShims({ ghToken: null }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings.join(" ")).toContain("gh auth login");
  });

  it("gives a browser command that uses a dedicated profile and can never attach to the user's Chrome", async () => {
    const repository = createRepository();
    const app = await startTestServer();
    const home = createHome();

    const result = await runCli(["start", "--url", app.url], { cwd: repository.path, home });

    const profile = join(home, ".pr-evidence", "acme__widgets", "browser-profile");
    expect(result.json.browser.profileDirectory).toBe(profile);
    expect(result.json.browser.commandPrefix).toContain(`CHROME_DEVTOOLS_AXI_USER_DATA_DIR='${profile}'`);
    expect(result.json.browser.commandPrefix).toContain("-u CHROME_DEVTOOLS_AXI_AUTO_CONNECT");
    expect(result.json.browser.commandPrefix).toContain("-u CHROME_DEVTOOLS_AXI_BROWSER_URL");
  });

  it("warns when the skill and helper versions differ", async () => {
    const repository = createRepository();
    const app = await startTestServer();

    const result = await runCli(["start", "--url", app.url, "--skill-version", "0.0.0-old"], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings.join(" ")).toMatch(/npx pr-evidence setup/);
  });

  it("does not warn when the skill and helper versions match", async () => {
    const repository = createRepository();
    const app = await startTestServer();

    const result = await runCli(["start", "--url", app.url, "--skill-version", helperVersion], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(result.json.warnings).toEqual([]);
  });
});

describe("cli", () => {
  it("prints its version", async () => {
    const result = await runCli(["--version"], {
      cwd: createTemporaryDirectory(),
      home: createHome(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.version).toBe(helperVersion);
  });

  it("lists its commands", async () => {
    const result = await runCli(["--help"], {
      cwd: createTemporaryDirectory(),
      home: createHome(),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(result.json.commands)).toContain("publish");
  });

  it("reports a bad flag as a usage error", async () => {
    const result = await runCli(["start", "--nonsense"], {
      cwd: createTemporaryDirectory(),
      home: createHome(),
    });

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("usage");
  });
});
