import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function packageFile(relativePath: string): string {
  return fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
}

export const helperVersion = (
  JSON.parse(readFileSync(packageFile("package.json"), "utf8")) as { version: string }
).version;

export function readSkillTemplate(): string {
  return readFileSync(packageFile("skill/SKILL.md"), "utf8");
}
