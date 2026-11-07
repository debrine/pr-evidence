import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { startFakeGitHub } from "./support/fakeGitHub.js";
import { startFakeRegistry, type FakeRegistry } from "./support/fakeRegistry.js";
import {
  createHome,
  createRepository,
  createTemporaryDirectory,
  createToolShims,
  runCli,
  startTestServer,
} from "./support/harness.js";
import { helperVersion, npxCommand } from "./support/helperRelease.js";

const skillPaths = {
  claude: [".claude", "skills", "pr-evidence", "SKILL.md"],
  codex: [".agents", "skills", "pr-evidence", "SKILL.md"],
  cursor: [".cursor", "skills", "pr-evidence", "SKILL.md"],
};

function homeWithAgents(...agentDirectories: string[]): string {
  return addAgents(createHome(), agentDirectories);
}

function addAgents(home: string, agentDirectories: string[]): string {
  for (const directory of agentDirectories) {
    mkdirSync(join(home, directory), { recursive: true });
  }
  return home;
}

function appDirectory(home: string): string {
  return join(home, ".pr-evidence", "app");
}

function readSkill(home: string, agent: keyof typeof skillPaths = "claude"): string {
  return readFileSync(join(home, ...skillPaths[agent]), "utf8");
}

/** The path in the command the skill gives the agent to start a run. */
function helperPathIn(skill: string): string {
  return /^node "(.+)" start /m.exec(skill)![1]!;
}

function runInstalledHelper(helperPath: string, ...args: string[]): string {
  return execFileSync(process.execPath, [helperPath, ...args], { encoding: "utf8" });
}

/** Makes a folder impossible to delete, in whichever way this platform allows. */
async function blockRemoval(directory: string): Promise<() => void> {
  if (process.platform !== "win32") {
    chmodSync(directory, 0o500);
    return () => chmodSync(directory, 0o700);
  }
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: directory });
  await once(holder, "spawn");
  return () => holder.kill();
}

describe("setup", () => {
  let registry: FakeRegistry;

  beforeEach(async () => {
    registry = await startFakeRegistry();
  });

  function runSetup(home: string, env = registry.env, ...args: string[]) {
    return runCli(["setup", ...args], { cwd: createTemporaryDirectory(), home, env });
  }

  it("installs the helper into a versioned folder, and the skill runs that copy", async () => {
    const home = homeWithAgents(".claude");

    const result = await runSetup(home);

    expect(result.exitCode).toBe(0);
    const skill = readSkill(home);
    const helperPath = helperPathIn(skill);
    expect(isAbsolute(helperPath)).toBe(true);
    expect(helperPath.startsWith(join(appDirectory(home), helperVersion))).toBe(true);
    expect(result.json.helperPath).toBe(helperPath);
    expect(JSON.parse(runInstalledHelper(helperPath, "--version")).version).toBe(helperVersion);
  });

  it("gives the agent one command form, with no npx and no ~/", async () => {
    const home = homeWithAgents(".claude");

    await runSetup(home);

    const skill = readSkill(home);
    expect(skill).not.toContain("npx");
    expect(skill).not.toContain("~/");
    for (const command of ["start", "stop", "finish", "publish"]) {
      expect(skill).toContain(`node "${helperPathIn(skill)}" ${command}`);
    }
  });

  it("works in a home directory containing a space", async () => {
    const home = join(createTemporaryDirectory(), "Ada Lovelace");
    mkdirSync(join(home, ".claude"), { recursive: true });

    const result = await runSetup(home);

    expect(result.exitCode).toBe(0);
    const helperPath = helperPathIn(readSkill(home));
    expect(helperPath).toContain("Ada Lovelace");
    expect(JSON.parse(runInstalledHelper(helperPath, "--version")).version).toBe(helperVersion);
  });

  it("shares one installed helper between every agent", async () => {
    const home = homeWithAgents(".claude", ".codex");

    await runSetup(home);

    expect(helperPathIn(readSkill(home, "codex"))).toBe(helperPathIn(readSkill(home, "claude")));
    expect(readdirSync(appDirectory(home))).toEqual([helperVersion]);
  });

  it("installs into its own folder, even when the home directory is an npm project", async () => {
    const home = homeWithAgents(".claude");
    const homeManifest = '{ "name": "my-home" }\n';
    writeFileSync(join(home, "package.json"), homeManifest);

    await runSetup(home);

    expect(readFileSync(join(home, "package.json"), "utf8")).toBe(homeManifest);
    expect(existsSync(join(home, "node_modules"))).toBe(false);
    expect(existsSync(helperPathIn(readSkill(home)))).toBe(true);
  });

  it("moves every agent with the skill onto the new helper, not only the one named", async () => {
    const home = homeWithAgents(".claude");
    const claudeSkill = join(home, ...skillPaths.claude);
    mkdirSync(dirname(claudeSkill), { recursive: true });
    writeFileSync(claudeSkill, `node "${join(appDirectory(home), "0.0.1", "cli.js")}" start \n`);
    mkdirSync(join(appDirectory(home), "0.0.1"), { recursive: true });

    const result = await runSetup(home, registry.env, "--agent", "cursor");

    expect(result.json.installed.map((entry: { agent: string }) => entry.agent)).toEqual(["claude", "cursor"]);
    expect(existsSync(helperPathIn(readSkill(home, "claude")))).toBe(true);
    expect(helperPathIn(readSkill(home, "claude"))).toBe(helperPathIn(readSkill(home, "cursor")));
  });

  it("removes older installed versions", async () => {
    const home = homeWithAgents(".claude");
    mkdirSync(join(appDirectory(home), "0.0.1", "node_modules"), { recursive: true });

    await runSetup(home);

    expect(readdirSync(appDirectory(home))).toEqual([helperVersion]);
  });

  it("carries on when an older version cannot be removed", async () => {
    const home = homeWithAgents(".claude");
    const oldVersion = join(appDirectory(home), "0.0.1");
    mkdirSync(oldVersion, { recursive: true });
    writeFileSync(join(oldVersion, "held-open.js"), "");
    const allowRemoval = await blockRemoval(oldVersion);

    try {
      const result = await runSetup(home);

      expect(result.exitCode).toBe(0);
      expect(existsSync(oldVersion)).toBe(true);
      expect(existsSync(helperPathIn(readSkill(home)))).toBe(true);
      expect(result.stderr).toContain("0.0.1");
    } finally {
      allowRemoval();
    }
  });

  it("reports a failed install, pointing at registry and proxy settings", async () => {
    const home = homeWithAgents(".claude");
    const registryWithoutHelper = await startFakeRegistry({ withoutHelper: true });

    const result = await runSetup(home, registryWithoutHelper.env);

    expect(result.exitCode).toBe(2);
    expect(result.json.error.code).toBe("install_failed");
    expect(result.json.error.message).toMatch(/registry/);
    expect(result.json.error.message).toMatch(/proxy/);
    expect(result.json.error.npmOutput).toContain("404");
  });

  it("leaves the existing install and skill alone when an upgrade fails", async () => {
    const home = homeWithAgents(".claude");
    const skillPath = join(home, ...skillPaths.claude);
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "the working skill");
    const oldVersion = join(appDirectory(home), "0.0.1");
    mkdirSync(oldVersion, { recursive: true });
    const registryWithoutHelper = await startFakeRegistry({ withoutHelper: true });

    await runSetup(home, registryWithoutHelper.env);

    expect(readFileSync(skillPath, "utf8")).toBe("the working skill");
    expect(existsSync(oldVersion)).toBe(true);
  });

  it("needs no registry to run again once the version is installed", async () => {
    const home = homeWithAgents(".claude");
    await runSetup(home);
    mkdirSync(join(home, ".cursor"));

    const result = await runSetup(home, {
      npm_config_registry: "http://127.0.0.1:9/",
      npm_config_fetch_retries: "0",
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, ...skillPaths.cursor))).toBe(true);
  });

  it("finishes an install that was interrupted", async () => {
    const home = homeWithAgents(".claude");
    const interruptedInstall = join(appDirectory(home), helperVersion);
    mkdirSync(interruptedInstall, { recursive: true });

    const result = await runSetup(home);

    expect(result.exitCode).toBe(0);
    expect(existsSync(helperPathIn(readSkill(home)))).toBe(true);
  });

  it("installs an unreleased build from a named tarball, every time", async () => {
    const home = homeWithAgents(".claude");
    const registryWithoutHelper = await startFakeRegistry({ withoutHelper: true });
    const env = { ...registryWithoutHelper.env, PR_EVIDENCE_INSTALL_SOURCE: registry.helperTarballPath };
    await runSetup(home, env);
    const helperPath = helperPathIn(readSkill(home));
    rmSync(helperPath);

    const result = await runSetup(home, env);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(runInstalledHelper(helperPath, "--version")).version).toBe(helperVersion);
  });

  it("installs the skill for every agent it finds, and only those", async () => {
    const home = homeWithAgents(".claude", ".codex");

    const result = await runSetup(home);

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

    const result = await runSetup(home, registry.env, "--agent", "cursor");

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, ...skillPaths.cursor))).toBe(true);
  });

  it("writes a skill with valid frontmatter that carries the helper version", async () => {
    const home = homeWithAgents(".claude");

    await runSetup(home);

    const skill = readSkill(home);
    expect(skill).toMatch(/^---\nname: pr-evidence\ndescription: .+\n---\n/);
    expect(skill).toContain(`--skill-version ${helperVersion}`);
    expect(skill).not.toContain("{{");
  });

  it("replaces an older copy of the skill", async () => {
    const home = homeWithAgents(".claude");
    const skillPath = join(home, ...skillPaths.claude);
    mkdirSync(join(skillPath, ".."), { recursive: true });
    writeFileSync(skillPath, "old");

    await runSetup(home);

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
      env: registry.env,
    });

    expect(result.json.ready).toBe(true);
    expect(result.json.missingPrerequisites).toEqual([]);
  });

  it("names each missing prerequisite and how to fix it", async () => {
    const result = await runCli(["setup"], {
      cwd: createTemporaryDirectory(),
      home: homeWithAgents(".claude"),
      env: registry.env,
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

    const profile = join(dirname(result.json.runDirectory), "browser-profile");
    expect(result.json.browser.profileDirectory).toBe(profile);
    expect(result.json.browser.commandPrefix).toContain(`CHROME_DEVTOOLS_AXI_USER_DATA_DIR='${profile}'`);
    expect(result.json.browser.commandPrefix).toContain("-u CHROME_DEVTOOLS_AXI_AUTO_CONNECT");
    expect(result.json.browser.commandPrefix).toContain("-u CHROME_DEVTOOLS_AXI_BROWSER_URL");
    expect(result.json.browser.commandPrefix).toContain("-u CHROME_DEVTOOLS_AXI_MCP_SERVER_URL");
  });

  it("warns at the start of a run when evidence could never be published", async () => {
    const repository = createRepository({ remoteUrl: "git@git.corp.example:acme/widgets.git" });
    const app = await startTestServer();

    const result = await runCli(["start", "--url", app.url], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings.join(" ")).toMatch(/Enterprise Server/);
  });

  it("warns when the skill and helper versions differ, naming the setup command for this helper", async () => {
    const repository = createRepository();
    const app = await startTestServer();

    const result = await runCli(["start", "--url", app.url, "--skill-version", "0.0.0-old"], {
      cwd: repository.path,
      home: createHome(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toContain(
      `The skill is version 0.0.0-old but the helper is ${helperVersion}. Run: ${npxCommand} pr-evidence@${helperVersion} setup`,
    );
  });

  it("does not warn when the skill and helper versions match", async () => {
    const repository = createRepository();
    const app = await startTestServer();
    const github = await startFakeGitHub();

    const result = await runCli(["start", "--url", app.url, "--skill-version", helperVersion], {
      cwd: repository.path,
      home: createHome(),
      env: { PR_EVIDENCE_GITHUB_BASE_URL: github.baseUrl },
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
