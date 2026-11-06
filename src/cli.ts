#!/usr/bin/env node
import { parseArgs } from "node:util";
import { start } from "./commands/start.js";
import { stopLatestRunApp } from "./commands/stop.js";
import { CliError } from "./errors.js";
import { readRepoState } from "./repoState.js";

const toolFailureExitCode = 2;

function print(document: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

async function runCommand(argv: string[]): Promise<Record<string, unknown>> {
  const [command, ...commandArgs] = argv;
  switch (command) {
    case "start": {
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          "allow-dirty": { type: "boolean", default: false },
          url: { type: "string" },
        },
      });
      return start({
        repositoryPath: process.cwd(),
        allowDirty: values["allow-dirty"],
        url: values.url,
      });
    }
    case "stop":
      return {
        stopped: await stopLatestRunApp(readRepoState(process.cwd()).repositoryKey),
      };
    default:
      throw new CliError("unknown_command", `Unknown command: ${command ?? "(none)"}`);
  }
}

try {
  print({ ok: true, ...(await runCommand(process.argv.slice(2))) });
} catch (error) {
  const failure =
    error instanceof CliError ? error : new CliError("unexpected_error", String(error));
  print({
    ok: false,
    error: { code: failure.code, message: failure.message, ...failure.details },
  });
  process.exitCode = toolFailureExitCode;
}
