import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startFakeGitHub } from "./support/fakeGitHub.js";
import { startUnresponsiveRegistry, startVersionRegistry } from "./support/fakeRegistry.js";
import { createHome, createRepository, runCli, startTestServer } from "./support/harness.js";

const helperVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

async function startWithRegistry(registryEnv: Record<string, string>) {
  const repository = createRepository();
  const app = await startTestServer();
  const github = await startFakeGitHub();
  return runCli(["start", "--url", app.url, "--skill-version", helperVersion], {
    cwd: repository.path,
    home: createHome(),
    env: { PR_EVIDENCE_GITHUB_BASE_URL: github.baseUrl, ...registryEnv },
  });
}

describe("update warning", () => {
  it("names the exact update command when the registry has a newer version", async () => {
    const registry = await startVersionRegistry("99.0.0");

    const result = await startWithRegistry(registry.env);

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toEqual([
      `pr-evidence 99.0.0 is available, and this is ${helperVersion}. Run: ${npxCommand} pr-evidence@99.0.0 setup`,
    ]);
  });

  it("adds no warning and still starts when the registry is unreachable", async () => {
    const result = await startWithRegistry({ PR_EVIDENCE_REGISTRY_URL: "http://127.0.0.1:9" });

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toEqual([]);
  });

  it("gives up on a registry that does not answer after about 2 seconds, without failing", async () => {
    const timeStart = async (registryEnv: Record<string, string>) => {
      const startedAt = performance.now();
      const result = await startWithRegistry(registryEnv);
      return { result, elapsedMilliseconds: performance.now() - startedAt };
    };
    const unreachable = await timeStart({ PR_EVIDENCE_REGISTRY_URL: "http://127.0.0.1:9" });
    const registry = await startUnresponsiveRegistry();

    const unresponsive = await timeStart(registry.env);

    expect(unresponsive.result.exitCode).toBe(0);
    expect(unresponsive.result.json.warnings).toEqual([]);
    // At most the 2 second timeout on top of a run that never waited for the registry, plus scheduling slack.
    expect(unresponsive.elapsedMilliseconds).toBeLessThan(unreachable.elapsedMilliseconds + 3_000);
  }, 20_000);

  it("adds no warning when this is the latest version", async () => {
    const registry = await startVersionRegistry(helperVersion);

    const result = await startWithRegistry(registry.env);

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toEqual([]);
  });

  it("adds no warning when this is newer than the latest published version", async () => {
    const registry = await startVersionRegistry("0.0.1");

    const result = await startWithRegistry(registry.env);

    expect(result.exitCode).toBe(0);
    expect(result.json.warnings).toEqual([]);
  });
});
