import { readFileSync } from "node:fs";

/** The version of the helper under test, from its manifest. */
export const helperVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;

/** How a developer runs npx: Windows needs the .cmd shim named, because PowerShell can block npx.ps1. */
export const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
