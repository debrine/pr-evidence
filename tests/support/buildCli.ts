import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export default function buildCli(): void {
  const typescriptCompiler = resolve("node_modules/typescript/bin/tsc");
  execFileSync(process.execPath, [typescriptCompiler, "-p", "tsconfig.build.json"], { stdio: "inherit" });
}
