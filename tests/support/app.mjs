// A tiny real app. Usage: node app.mjs <port> <pidFile> [delayMilliseconds]
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, pidFile, delayMilliseconds = "0"] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
console.log("sample app booting");
setTimeout(() => {
  createServer((_request, response) => response.end("ok")).listen(Number(port), "127.0.0.1");
}, Number(delayMilliseconds));
