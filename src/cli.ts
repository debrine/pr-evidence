#!/usr/bin/env node
import { parseArgs } from "node:util";
import { finish } from "./commands/finish.js";
import { publish } from "./commands/publish.js";
import { setup } from "./commands/setup.js";
import { start } from "./commands/start.js";
import { stopLatestRunApp } from "./commands/stop.js";
import { CliError } from "./errors.js";
import { helperVersion } from "./packageInfo.js";
import { readRepoState } from "./repoState.js";

const failedCriteriaExitCode = 1;
const toolFailureExitCode = 2;
const commands = [
  { usage: "setup [--agent claude|codex|cursor]...", description: "Install the skill and check prerequisites." },
  { usage: "start [--url <url>] [--allow-dirty] [--skill-version <version>]", description: "Begin a run for the current commit, starting the configured app unless --url is given." },
  { usage: "finish --results <file>", description: "Stop the app, record the results and build the GIF. Exits 1 if a criterion failed." },
  { usage: "stop", description: "Abandon a run, stopping any app it started." },
  { usage: "publish", description: "Prefer the checked-out commit's finished run, otherwise use this checkout's latest run, which must be finished; upload it and update the evidence comment on its PR." },
];

function print(document: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

async function runCommand(argv: string[]): Promise<Record<string, unknown>> {
  const [command, ...commandArgs] = argv;
  switch (command) {
    case "--version":
    case "-v":
      return { version: helperVersion };
    case undefined:
    case "--help":
    case "-h":
      return { commands };
    case "setup": {
      const { values } = parseArgs({
        args: commandArgs,
        options: { agent: { type: "string", multiple: true, default: [] } },
      });
      return setup(values.agent);
    }
    case "start": {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          "allow-dirty": { type: "boolean", default: false },
          url: { type: "string" },
          "skill-version": { type: "string" },
        },
      });
      return start({
        repositoryPath: process.cwd(),
        allowDirty: values["allow-dirty"],
        url: values.url,
        skillVersion: values["skill-version"],
      });
    }
    case "finish": {
      const { values } = parseArgs({
        args: commandArgs,
        options: { results: { type: "string" } },
      });
      if (values.results === undefined) {
        throw new CliError("usage", "finish needs --results <file>.");
      }
      const outcome = await finish(process.cwd(), values.results);
      if (outcome.result === "fail") {
        process.exitCode = failedCriteriaExitCode;
      }
      return { ...outcome };
    }
    case "publish":
      return publish(process.cwd());
    case "stop":
      return {
        stopped: await stopLatestRunApp(readRepoState(process.cwd())),
      };
    default:
      throw new CliError("unknown_command", `Unknown command: ${command}`);
  }
}

function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  const isUsageError = String((error as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS");
  return isUsageError
    ? new CliError("usage", (error as Error).message)
    : new CliError("unexpected_error", String(error));
}

try {
  print({ ok: true, ...(await runCommand(process.argv.slice(2))) });
} catch (error) {
  const failure = toCliError(error);
  print({
    ok: false,
    error: { code: failure.code, message: failure.message, ...failure.details },
  });
  process.exitCode = toolFailureExitCode;
}
