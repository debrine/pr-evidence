import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { CliError } from "./errors.js";

export const configFileName = ".pr-evidence.yml";

export interface LoginEnvironment {
  usernameEnv?: string;
  passwordEnv?: string;
}

export interface Config {
  start: string;
  readyUrl: string;
  login?: LoginEnvironment;
  ticketFolder?: string;
}

function invalid(problem: string): CliError {
  return new CliError("config_invalid", `${configFileName}: ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKnownKeys(
  record: Record<string, unknown>,
  knownKeys: string[],
  prefix: string,
): void {
  const unknownKey = Object.keys(record).find((key) => !knownKeys.includes(key));
  if (unknownKey !== undefined) {
    throw invalid(`unknown key "${prefix}${unknownKey}". Allowed: ${knownKeys.join(", ")}.`);
  }
}

function requireNonEmptyString(value: unknown, keyName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`"${keyName}" must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, keyName: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, keyName);
}

function parseHttpUrl(value: string, keyName: string): string {
  let protocol: string | undefined;
  try {
    protocol = new URL(value).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw invalid(`"${keyName}" must be an http or https URL.`);
  }
  return value;
}

function parseLogin(value: unknown): LoginEnvironment | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalid('"login" must be a mapping of env var names.');
  }
  assertOnlyKnownKeys(value, ["usernameEnv", "passwordEnv"], "login.");
  return {
    usernameEnv: optionalString(value.usernameEnv, "login.usernameEnv"),
    passwordEnv: optionalString(value.passwordEnv, "login.passwordEnv"),
  };
}

/** Returns null when the repo has no config file. */
export function loadConfig(repositoryRoot: string): Config | null {
  const path = join(repositoryRoot, configFileName);
  if (!existsSync(path)) {
    return null;
  }
  let document: unknown;
  try {
    document = parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw invalid(`could not parse YAML: ${String(cause)}`);
  }
  if (!isRecord(document)) {
    throw invalid("expected a mapping with at least start and readyUrl.");
  }
  assertOnlyKnownKeys(document, ["start", "readyUrl", "login", "ticketFolder"], "");
  return {
    start: requireNonEmptyString(document.start, "start"),
    readyUrl: parseHttpUrl(requireNonEmptyString(document.readyUrl, "readyUrl"), "readyUrl"),
    login: parseLogin(document.login),
    ticketFolder: optionalString(document.ticketFolder, "ticketFolder"),
  };
}
