import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
const systemRoot = process.env.SystemRoot;
const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const git = execFileSync("where.exe", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0];
const minimal = { HOME: tmpdir(), USERPROFILE: tmpdir(), PATH: [join(systemRoot, "System32"), systemRoot, dirname(git)].join(";"), SystemRoot: systemRoot, TEMP: tmpdir(), TMP: tmpdir() };
const variants = {
  full: process.env,
  minimal,
  minimalWindir: { ...minimal, windir: process.env.windir },
  minimalPSModulePath: { ...minimal, PSModulePath: process.env.PSModulePath },
  minimalAppData: { ...minimal, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA },
  minimalProgramFiles: { ...minimal, ProgramFiles: process.env.ProgramFiles, ProgramData: process.env.ProgramData, "ProgramFiles(x86)": process.env["ProgramFiles(x86)"] },
};
const commands = {
  getProcess: `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
  importedGetProcess: `Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Management"; (Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
  dotnet: `[System.Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().ToString('o')`,
};
for (const [variantName, env] of Object.entries(variants)) {
  for (const [commandName, command] of Object.entries(commands)) {
    for (const round of [1, 2]) {
      const started = Date.now();
      let output;
      try {
        output = execFileSync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", command], { env, encoding: "utf8", windowsHide: true }).trim();
      } catch (error) { output = `ERROR ${error.message}`; }
      console.log(`${variantName} ${commandName} round ${round}: ${Date.now() - started}ms ${output}`);
    }
  }
}
for (const variantName of ["full", "minimal"]) {
  const started = Date.now();
  try { execFileSync(join(systemRoot, "System32", "taskkill.exe"), ["/PID", "999999", "/T"], { env: variants[variantName], stdio: "ignore", windowsHide: true }); } catch {}
  console.log(`${variantName} taskkill: ${Date.now() - started}ms`);
}
