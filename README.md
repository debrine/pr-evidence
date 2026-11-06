# pr-evidence

In development. This branch provides the `start` and `stop` CLI foundation for testing a branch in a real browser and posting screenshots and GIFs as pull request evidence. Browser testing, `finish`, `publish`, `setup`, and the skill are deferred.

## Usage

Requires Node.js 20 or later, npm, Git, and a Unix environment with `sh`, `ps`, and process group signals. From this checkout:

```sh
npm ci
npm run build
```

Run the built CLI from inside the Git repository being tested, which must have at least one commit. Replace `/path/to/pr-evidence` below with the absolute path to this checkout.

Commit a `.pr-evidence.yml` at the tested repository's root, using your app's command and URL:

```yaml
start: npm run dev
readyUrl: http://localhost:3000
```

```sh
node /path/to/pr-evidence/dist/cli.js start
node /path/to/pr-evidence/dist/cli.js stop
```

`start` requires a clean working tree, including untracked files and submodule changes, regardless of Git display preferences. Use `start --allow-dirty` for a quick check; its output and run record mark the run as dirty.

The configured command runs from the tested repository's root. It must stay in the foreground. An exit observed during startup, including status zero, fails with a foreground-command error. Detached processes left behind by unsupported launchers are outside this tool's ownership and must be cleaned up separately. After `start` returns, there is no ongoing supervisor to report later command exits.

Startup waits up to two minutes for an HTTP response below 500 from `readyUrl`; redirects are not followed. An existing response at that URL prevents launching over another app. Failed startup stops the owned process group and reports recent app output. `PR_EVIDENCE_READY_TIMEOUT_MS` is a test-only timeout override.

During pending startup, `SIGINT` or `SIGTERM` stops the owned process group, clears its ownership record, and returns an `app_interrupted` JSON error. These temporary signal handlers are removed when startup completes.

To use an already running app without taking ownership of it:

```sh
node /path/to/pr-evidence/dist/cli.js start --url http://localhost:3000
```

This mode requires an HTTP response, including an error status. It needs no config file, but an existing config is still validated. `stop` never stops the external app. Each `start` first stops the app owned by the repository's previous run; `stop` also targets only that latest owned run.

Both commands print JSON with `ok`. A successful `start` includes the commit SHA, branch, dirty flag, URL, run and screenshot directories, and optional login and ticket metadata. A successful `stop` includes `stopped`. Failures exit with status 2 and include an `error` with a stable `code` and a human-readable `message`.

## Configuration and stored evidence

Config requires nonempty `start` and `readyUrl` strings; `readyUrl` must be HTTP or HTTPS. Optional `login.usernameEnv` and `login.passwordEnv` are environment variable names, and optional `ticketFolder` is a nonempty string. These optional fields are returned as metadata; this foundation does not log in or read tickets. Unknown configuration keys are rejected.

Runs live under `~/.pr-evidence/<repository-key>/<sha>/`, containing `run.json`, a `screenshots/` directory, and `app.log` for a launched app. Repeating a commit replaces its earlier evidence. On `start`, runs across repositories whose run records were last modified more than 14 days ago are pruned, except those with a live owned app.

Network repository keys hash the origin's host, nondefault port, owner, and name. Default HTTP, HTTPS, and SSH transports share an identity. Filesystem or unrecognized origins and repositories without an origin instead use Git's absolute common directory. Linked worktrees therefore share ownership and evidence; per-worktree isolation is deferred. Earlier ambiguous namespaces are not migrated, but their expired runs remain eligible for pruning.

See the [v1 spec](https://github.com/debrine/pr-evidence/issues/1).
