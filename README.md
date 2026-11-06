# pr-evidence

In development. This branch provides `start`, `stop`, and `finish` to manage a test run, record criterion results, and build a GIF from captured screenshots, plus `publish` to upload evidence and maintain a PR comment. Browser automation, `setup`, and the skill are deferred.

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

All commands print JSON with `ok`. A successful `start` includes the commit SHA, branch, dirty flag, URL, run and screenshot directories, and optional login and ticket metadata. A successful `stop` includes `stopped`. Tool errors exit with status 2 and include an `error` with a stable `code` and a human-readable `message`.

## Finish a run

Save PNG screenshots in the directory returned by `start`, using sortable names such as `001-loaded.png` and `002-saved.png`. Write a results JSON file with a nonempty `criteria` array:

```json
{
  "ticket": "ABC-1",
  "criteria": [
    { "description": "Page loads", "result": "pass", "screenshot": "001-loaded.png" },
    { "description": "Save succeeds", "result": "fail", "note": "Server returned 500" }
  ]
}
```

Each criterion requires a nonempty `description` and a `result` of `pass` or `fail`. Optional `screenshot` names a captured PNG file in that run, without a directory path; optional `note` is a string. The top-level `ticket` is an optional string or null.

```sh
node /path/to/pr-evidence/dist/cli.js finish --results /path/to/results.json
```

`finish` stops the latest run's owned app, validates the results, and builds `evidence.gif` from all captured PNG files in filename order. It persists the outcome in `run.json` and prints `ok: true`, `result`, `ticket`, `criteria`, `screenshots`, and `gifPath`. With no screenshots, `gifPath` is null. The GIF loops with 1.5 seconds per frame and is reduced to fit within 10 MiB. Screenshots retain their proportions and are scaled to fit the GIF format's limit of 65,535 pixels per dimension.

Exit status is 0 when every criterion passes, 1 when any criterion fails (with evidence still produced and `ok: true`), or 2 for a tool error such as invalid results, a missing run, or a GIF build failure.

## Publish evidence

Install the GitHub CLI (`gh`) and authenticate with `gh auth login --hostname github.com` (use your host for Enterprise Cloud). Publishing requires repository write access and an OAuth or personal access token; GitHub App and Actions tokens are refused. Supported hosts are `github.com` and `*.ghe.com`, not GitHub Enterprise Server.

After `finish`, run from the tested repository:

```sh
node /path/to/pr-evidence/dist/cli.js publish
```

`publish` selects the repository's latest saved run, which must be finished, and finds an open PR using that run's saved branch and origin repository. PRs from forks are not found. If no PR is found, the command exits with status 2 and keeps the evidence so you can open a PR and retry.

The command uploads the GIF, when present, and all screenshots, then creates or replaces an evidence comment containing the result, tested commit, ticket, criterion results, failed-criterion images, GIF, and collapsed screenshots. It matches an existing comment by the `<!-- pr-evidence -->` marker at its start and the authenticated author. Two colleagues publishing to the same PR therefore get separate comments; neither adopts the other's comment.

If the tested commit is not on GitHub, publishing exits with status 2 and asks you to push it first, before uploading or changing a comment. If the commit is on GitHub but differs from the PR head, publishing proceeds with the warning "The PR head differs from the tested commit" in both the comment and JSON output. Runs made with `--allow-dirty` also carry a comment warning about uncommitted changes.

Uploads use an undocumented GitHub attachment endpoint and fail closed on errors or unexpected attachment URLs. PNG and GIF uploads must be nonempty and at most 10 MiB each. All uploads complete before the comment is changed, so an upload failure leaves the comment untouched, though earlier uploads may already exist. Image rendering in a real PR has not yet been verified.

Success exits with status 0 and prints `ok: true`, `pullRequest` (number and URL), `commentUrl`, and `warnings`. This status indicates successful publication even when the run's criteria failed. Tool errors exit with status 2.

## Configuration and stored evidence

Config requires nonempty `start` and `readyUrl` strings; `readyUrl` must be HTTP or HTTPS. Optional `login.usernameEnv` and `login.passwordEnv` are environment variable names, and optional `ticketFolder` is a nonempty string. These optional fields are returned as metadata; this foundation does not log in or read tickets. Unknown configuration keys are rejected.

Runs live under `~/.pr-evidence/<repository-key>/<sha>/`, containing `run.json`, a `screenshots/` directory, and `app.log` for a launched app. Repeating a commit replaces its earlier evidence. On `start`, runs across repositories whose run records were last modified more than 14 days ago are pruned, except those with a live owned app.

Network repository keys hash the origin's host, nondefault port, owner, and name. Default HTTP, HTTPS, and SSH transports share an identity. Filesystem or unrecognized origins and repositories without an origin instead use Git's absolute common directory. Linked worktrees therefore share ownership and evidence; per-worktree isolation is deferred. Earlier ambiguous namespaces are not migrated, but their expired runs remain eligible for pruning.

See the [v1 spec](https://github.com/debrine/pr-evidence/issues/1).
