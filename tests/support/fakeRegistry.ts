import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach } from "vitest";

interface PackedPackage {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  tarballPath: string;
}

export interface FakeRegistry {
  /** Points npm at this registry, and fails at once rather than retrying for a minute. */
  env: Record<string, string>;
  /** The helper, as `npm pack` builds it for publishing. */
  helperTarballPath: string;
}

const helperPackageName = "pr-evidence";
const openServers: Server[] = [];
let packedPackages: { directory: string; packages: PackedPackage[] } | undefined;

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((closed) => server.close(closed));
    }),
  );
});

afterAll(() => {
  if (packedPackages) rmSync(packedPackages.directory, { recursive: true, force: true });
  packedPackages = undefined;
});

function packPackage(packageDirectory: string, destination: string): PackedPackage {
  const packed = execSync(
    `npm pack "${packageDirectory}" --ignore-scripts --pack-destination "${destination}" --loglevel=error`,
    { encoding: "utf8" },
  );
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  return {
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies ?? {},
    tarballPath: join(destination, packed.trim().split(/\r?\n/).at(-1)!),
  };
}

/** Packed once per test file: the helper, and its dependencies from node_modules. */
function packHelperAndDependencies(): PackedPackage[] {
  if (!packedPackages) {
    const directory = mkdtempSync(join(tmpdir(), "pr-evidence-test-registry-"));
    const helper = packPackage(resolve("."), directory);
    const dependencies = Object.keys(helper.dependencies).map((name) =>
      packPackage(resolve("node_modules", name), directory),
    );
    packedPackages = { directory, packages: [helper, ...dependencies] };
  }
  return packedPackages.packages;
}

function packageDocument(baseUrl: string, { name, version, dependencies }: PackedPackage): string {
  return JSON.stringify({
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: { name, version, dependencies, dist: { tarball: `${baseUrl}/-/${name}.tgz` } },
    },
  });
}

/** A real npm registry on localhost, so that tests install without touching the network. */
export async function startFakeRegistry(options: { withoutHelper?: boolean } = {}): Promise<FakeRegistry> {
  const allPackages = packHelperAndDependencies();
  const served = allPackages.filter(
    (candidate) => !options.withoutHelper || candidate.name !== helperPackageName,
  );
  const baseUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const server = createServer((request, response) => {
    const packageName = decodeURIComponent(request.url!).replace(/^\/(-\/)?/, "").replace(/\.tgz$/, "");
    const requested = served.find((candidate) => candidate.name === packageName);
    if (requested === undefined) {
      response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
    } else if (request.url!.startsWith("/-/")) {
      response.end(readFileSync(requested.tarballPath));
    } else {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(packageDocument(baseUrl(), requested));
    }
  });
  openServers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    env: { npm_config_registry: `${baseUrl()}/`, npm_config_fetch_retries: "0" },
    helperTarballPath: allPackages.find((candidate) => candidate.name === helperPackageName)!.tarballPath,
  };
}

export interface FakeVersionRegistry {
  /** Points the update check at this registry. */
  env: Record<string, string>;
}

async function listenForVersionLookups(server: Server): Promise<FakeVersionRegistry> {
  openServers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    env: { PR_EVIDENCE_REGISTRY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
  };
}

/** A registry that only answers which helper version is the latest, without packing anything. */
export function startVersionRegistry(latestHelperVersion: string): Promise<FakeVersionRegistry> {
  const server = createServer((request, response) => {
    if (decodeURIComponent(request.url!) !== `/${helperPackageName}`) {
      response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ name: helperPackageName, "dist-tags": { latest: latestHelperVersion } }));
  });
  return listenForVersionLookups(server);
}

/** A registry that accepts the connection and never answers, like one behind a stalled proxy. */
export function startUnresponsiveRegistry(): Promise<FakeVersionRegistry> {
  return listenForVersionLookups(createServer(() => {}));
}
