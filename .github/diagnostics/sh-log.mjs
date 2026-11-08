import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
const shell = join(resolve(execPath, "..", "..", ".."), "usr", "bin", "sh.exe");
const directory = mkdtempSync(join(tmpdir(), "sh-log-"));
for (const flags of ["a", "w", "r+"]) {
  for (const detached of [true, false]) {
    const logPath = join(directory, `log-${flags.replace("+", "plus")}-${detached}.txt`);
    if (flags === "r+") closeSync(openSync(logPath, "w"));
    const descriptor = openSync(logPath, flags);
    const child = spawn(shell, ["-c", `echo builtin; printf 'printf\\n'; ${JSON.stringify(process.execPath).replaceAll("\\\\", "/")} -e "console.log('node')"; exit 3`], {
      detached, windowsHide: true, stdio: ["ignore", descriptor, descriptor],
    });
    closeSync(descriptor);
    const [code] = await once(child, "exit");
    console.log(`flags=${flags} detached=${detached} exit=${code} log=${JSON.stringify(readFileSync(logPath, "utf8"))}`);
  }
}
