import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, afterEach } from "vitest";

interface PackedPackage {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  /** As in the package's manifest. A real registry serves it, and `npm exec` needs it to find the command. */
  bin?: Record<string, string> | string;
  tarballPath: string;
}

export interface FakeRegistry {
  /** Points npm at this registry, and fails at once rather than retrying for a minute. */
  env: Record<string, string>;
  /** The helper, as `npm pack` builds it for publishing. */
  helperTarballPath: string;
  /** Stops answering, as a registry behind a failing proxy would. npm's cache stays keyed to the same URL. */
  stop(): Promise<void>;
}

const helperPackageName = "pr-evidence";
const browserCliPackageName = "chrome-devtools-axi";
const openServers: Server[] = [];
/** Packed once per test file, each tree only when a test first asks for it. */
let packed:
  | { directory: string; helper: PackedPackage; standInTree?: PackedPackage[]; realTree?: PackedPackage[] }
  | undefined;
let archiveCount = 0;

function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((closed) => server.close(() => closed()));
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(stopServer));
});

afterAll(() => {
  if (packed) rmSync(packed.directory, { recursive: true, force: true });
  packed = undefined;
});

function readPackage(packageDirectory: string, tarballPath: string): PackedPackage {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  return {
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies ?? {},
    bin: manifest.bin,
    tarballPath,
  };
}

/** The helper, as `npm pack` builds it for publishing. */
function packHelper(destination: string): PackedPackage {
  const packed = execSync(
    `npm pack "${resolve(".")}" --ignore-scripts --pack-destination "${destination}" --loglevel=error`,
    { encoding: "utf8" },
  );
  return readPackage(resolve("."), join(destination, packed.trim().split(/\r?\n/).at(-1)!));
}

/**
 * An installed dependency, archived as it is. Not with `npm pack`, which runs a dependency's
 * `prepare` script despite --ignore-scripts, and is slow when run once per package.
 */
function archiveDependency(packageDirectory: string, destination: string): PackedPackage {
  const tarballPath = join(destination, `dependency-${(archiveCount += 1)}.tgz`);
  // Windows' own tar, because a GNU tar earlier on PATH reads `C:` in a path as a remote host.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot!, "System32", "tar.exe") : "tar";
  execFileSync(tar, [
    "-czf", tarballPath, "--exclude=node_modules",
    "-C", dirname(packageDirectory), basename(packageDirectory),
  ]);
  return readPackage(packageDirectory, tarballPath);
}

/**
 * Every package the helper needs at run time, where the lockfile put it in node_modules.
 * Hoisted copies come first, so that each name's first version is the one most of the tree uses.
 */
function productionDependencyDirectories(): string[] {
  const lockedPackages = JSON.parse(readFileSync("package-lock.json", "utf8")).packages as Record<
    string,
    { dev?: boolean }
  >;
  const nestingDepth = (path: string) => path.split("node_modules/").length;
  return Object.entries(lockedPackages)
    .filter(([path, lockedPackage]) => path !== "" && !lockedPackage.dev)
    .map(([path]) => path)
    .sort((first, second) => nestingDepth(first) - nestingDepth(second))
    .map((path) => resolve(path));
}

/**
 * A chrome-devtools-axi with the pinned version and no dependencies. The real one brings
 * about a hundred packages, which take most of a test's time to install on Windows.
 */
function archiveBrowserCliStandIn(destination: string): PackedPackage {
  const { version } = JSON.parse(readFileSync(resolve("node_modules", browserCliPackageName, "package.json"), "utf8"));
  const packageDirectory = join(destination, "stand-in", browserCliPackageName);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: browserCliPackageName, version, type: "module", bin: { [browserCliPackageName]: "cli.js" } }),
  );
  writeFileSync(join(packageDirectory, "cli.js"), 'process.stdout.write("chrome-devtools-axi stand-in\\n");\n');
  return archiveDependency(packageDirectory, destination);
}

/** The helper's own dependencies, with a stand-in for the browser CLI. */
function packStandInTree(destination: string): PackedPackage[] {
  const helperDependencies = Object.keys(packed!.helper.dependencies).filter((name) => name !== browserCliPackageName);
  const dependencies = helperDependencies.map((name) => {
    const dependency = archiveDependency(resolve("node_modules", name), destination);
    if (Object.keys(dependency.dependencies).length > 0) {
      throw new Error(`${name} has dependencies of its own, so the stand-in tree would be incomplete.`);
    }
    return dependency;
  });
  return [...dependencies, archiveBrowserCliStandIn(destination)];
}

function packedTree(browserCli: BrowserCli): PackedPackage[] {
  if (!packed) {
    const directory = mkdtempSync(join(tmpdir(), "pr-evidence-test-registry-"));
    packed = { directory, helper: packHelper(directory) };
  }
  if (browserCli === "real") {
    packed.realTree ??= productionDependencyDirectories().map((packageDirectory) =>
      archiveDependency(packageDirectory, packed!.directory),
    );
    return packed.realTree;
  }
  packed.standInTree ??= packStandInTree(packed.directory);
  return packed.standInTree;
}

function tarballPathOf({ name, version }: PackedPackage): string {
  return `/-/${encodeURIComponent(name)}/${version}.tgz`;
}

/** Every version of one package, the first of them tagged as the latest. */
function packageDocument(baseUrl: string, versions: PackedPackage[]): string {
  return JSON.stringify({
    name: versions[0]!.name,
    "dist-tags": { latest: versions[0]!.version },
    versions: Object.fromEntries(
      versions.map((packed) => [
        packed.version,
        {
          name: packed.name,
          version: packed.version,
          dependencies: packed.dependencies,
          bin: packed.bin,
          dist: { tarball: `${baseUrl}${tarballPathOf(packed)}` },
        },
      ]),
    ),
  });
}

/**
 * "stand-in" serves a chrome-devtools-axi with no dependencies, which keeps installs quick.
 * "real" serves the real one and its whole dependency tree, for tests that run it or depend on its size.
 */
export type BrowserCli = "stand-in" | "real";

/** A real npm registry on localhost, so that tests install without touching the network. */
export async function startFakeRegistry(
  options: { withoutHelper?: boolean; browserCli?: BrowserCli } = {},
): Promise<FakeRegistry> {
  const tree = packedTree(options.browserCli ?? "stand-in");
  const helper = packed!.helper;
  const served = options.withoutHelper ? tree : [helper, ...tree];
  const baseUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const server = createServer((request, response) => {
    const tarball = served.find((candidate) => tarballPathOf(candidate) === request.url);
    const versions = served.filter(
      (candidate) => candidate.name === decodeURIComponent(request.url!).slice(1),
    );
    if (tarball !== undefined) {
      response.end(readFileSync(tarball.tarballPath));
    } else if (versions.length > 0) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(packageDocument(baseUrl(), versions));
    } else {
      response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
    }
  });
  openServers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    env: { npm_config_registry: `${baseUrl()}/`, npm_config_fetch_retries: "0" },
    helperTarballPath: helper.tarballPath,
    stop: async () => {
      const openIndex = openServers.indexOf(server);
      if (openIndex === -1) return;
      openServers.splice(openIndex, 1);
      await stopServer(server);
    },
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
