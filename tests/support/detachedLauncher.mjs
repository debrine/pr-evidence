import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const [mode, port, pidFile] = process.argv.slice(2);
if (mode === "server") {
  writeFileSync(pidFile, String(process.pid));
  createServer((_request, response) => {
    if (process.connected) process.send("requested");
    setTimeout(() => response.end("ok"), 400);
  }).listen(Number(port), "127.0.0.1", () => process.send?.("listening"));
} else {
  const server = spawn(process.execPath, [fileURLToPath(import.meta.url), "server", port, pidFile], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  server.on("message", (message) => {
    if (message === (mode === "before-probe" ? "listening" : "requested")) {
      process.exit(0);
    }
  });
}
