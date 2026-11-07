# pr-evidence

Test a branch in a real browser and post screenshots and a GIF as evidence on its pull request.

You ask your coding agent to gather evidence. It works out what to test from the diff, the PR description and the ticket, and you approve the list. It then drives a real browser against your running app and judges each criterion. You review the evidence, and one comment on the PR is created or updated.

The tool only reports. It never changes the code under test.

Web apps only, on github.com and `*.ghe.com`. macOS and Linux.

## Install

```sh
npx pr-evidence setup
```

The `npx` examples require a published release containing these changes. Until then, build this checkout with `npm ci` and `npm run build`, then use `node /absolute/path/to/pr-evidence/dist/cli.js setup`. For helper commands, run that CLI from the Git repository being tested. The installed skill also invokes `npx`, so using it requires the published release.

This installs the skill at user level for each agent it finds, and tells you if a prerequisite is missing:

| Agent | Skill location |
| --- | --- |
| Claude Code | `~/.claude/skills/pr-evidence` |
| Codex | `~/.agents/skills/pr-evidence` |
| Cursor | `~/.cursor/skills/pr-evidence` |

Use `--agent claude`, `--agent codex` or `--agent cursor` to choose instead.

You need Node 20 or later, npm, Git, a Unix environment with `sh`, `ps` and process group signals, the [GitHub CLI](https://cli.github.com) logged in with `gh auth login`, and `chrome-devtools-axi` (`npm install -g chrome-devtools-axi`). You do not need ffmpeg or ImageMagick.

## Configure a repo

Commit a `.pr-evidence.yml`. Your agent offers to draft it the first time.

```yaml
start: npm run dev # starts the app
readyUrl: http://localhost:3000 # answers once the app is up
login: # optional: names of env vars, never the values
  usernameEnv: APP_TEST_USER
  passwordEnv: APP_TEST_PASSWORD
ticketFolder: docs/tickets # optional: local Markdown tickets
```

The start command must stay in the foreground, so use `docker compose up` rather than `docker compose up -d`. If it exits during startup, even with status 0, `start` fails. An app it leaves running in the background is not tracked or stopped.

Without a config, pass `--url` to test an app that is already running or a preview deployment. An existing config is still validated, and the external app is never stopped by this tool.

### Apps with several processes

If the app needs setup steps or more than one process, commit a wrapper script and name it as `start`. Do the setup first, then stay in the foreground:

```sh
#!/bin/sh
set -e
docker compose up -d --wait # services this tool will not stop
npm run migrate
npm run seed
npm run start:api &
npm run start:web &
wait
```

Set `readyUrl` to the part that answers last. The script has two minutes to reach it. The tool stops the script and the processes it keeps in the foreground or starts with `&`. It does not stop services that run on their own, such as those from `docker compose up -d`, so stop them with `docker compose down`.

For a one-off run, start the stack yourself and pass `--url`. You then own the app and stop it afterwards.

## Use it

Ask your agent, for example:

> Gather evidence for this branch.

> Gather evidence for ABC-123 with --criteria "Saving twice does not create a duplicate".

| Option | Effect |
| --- | --- |
| `--ticket <path or key>` | Use this ticket |
| `--criteria "<text>"` | Add a criterion (repeatable) |
| `--criteria-file <path>` | Add criteria from a file |
| `--url <url>` | Test an app that is already running |
| `--allow-dirty` | Run with uncommitted changes. The evidence is marked |
| `--yes` | Skip the review before publishing |

## Logging in

By default you log in once by hand, in a browser profile kept for this tool, and runs reuse that session. MFA and SSO work, and the agent never sees your password. For simple apps, test credentials can come from the env vars named in the config instead.

The tool never uses your day-to-day browser profile.

## Before you publish

- GitHub offers no supported way to delete an uploaded file, so check the screenshots before you approve them.
- Use local or seeded data, not production.
- Files uploaded to a private repo need repository access to view.
- Publishing requires repository write access and an OAuth or personal access token from `gh`. GitHub App and Actions tokens are refused. For Enterprise Cloud, log in with `gh auth login --hostname <host>`.
- `start` warns if the commit is not the head of the open PR for the branch, or if it could not check, so you can stop before testing.
- Push the tested commit first. Publishing refuses a commit that is not on GitHub, before uploading anything.
- If the commit is on GitHub but is not the PR head, the evidence is still posted, with the warning "The PR head differs from the tested commit".
- PRs from forks are not found.
- Each person who publishes on a PR gets their own evidence comment, so nobody can edit another person's evidence.

Evidence is saved in `~/.pr-evidence/<repository-key>/<sha>/`. On `start`, runs whose records have not changed in 14 days are pruned, except those with a live app owned by this tool. Running the same commit again replaces its earlier evidence. If the branch has no PR yet, the evidence is kept subject to that retention rule. After opening a PR, run `npx pr-evidence publish`: it prefers a finished run for the checked-out commit, otherwise selects this checkout's latest run, which must be finished. It finds the PR using the selected run's saved branch and origin repository.

To test two branches at once, use separate `git worktree` checkouts. Their apps and runs stay apart when testing different commits. The same commit can have only one unfinished run across checkouts: start exits 2 without changing evidence if another checkout owns that run. Finish it in its owning checkout first; starting the commit elsewhere then replaces its evidence. Stop and finish ignore runs owned by another checkout. Worktrees share a saved browser profile, so run the browser steps one at a time.

## Helper commands

The skill runs these for you. Each prints one JSON document. The exit code is 0 for success, 1 when a criterion failed and 2 when the tool itself failed.

| Command | Purpose |
| --- | --- |
| `setup` | Install the skill and check prerequisites |
| `start` | Begin a run for the current commit |
| `finish --results <file>` | Stop the app, record results and build the GIF |
| `stop` | Abandon a run |
| `publish` | Publish saved evidence as described above |

`finish` reports GIF encoding or size-limit failures as warnings and keeps the results and screenshots, with `gifPath: null`. Review those warnings before publishing.

## How the upload works

GitHub has no documented API for this. The upload uses the endpoint behind the comment box, authenticated with your `gh` token, so it could change without notice. `npm run test:smoke` checks it with one real upload, which cannot be deleted afterwards.

PNG and GIF uploads must be nonempty and at most 10 MiB each. All files are uploaded before the PR comment is changed. If a later upload fails, earlier uploaded assets may remain even though the comment is untouched. A comment request failure can leave publication uncertain; inspect the PR before retrying.

The upload contract follows [no-mistakes](https://github.com/kunchenguid/no-mistakes) (MIT).

## Development

```sh
npm install
npm test
npm run typecheck
```

The regular tests run the built CLI as a black box, against real git repos, a real HTTP server and a local fake of GitHub. The opt-in upload smoke test imports `src` directly.

## Releasing

After `npm publish`, the registry can list the new version before its tarball is available. Until it is, `npx` fails with `could not determine executable to run`, and the tarball URL returns 404. For `0.1.0` this took about 8 minutes. Wait for this to succeed before testing the release:

```sh
curl -fsI "$(npm view pr-evidence@<version> dist.tarball)"
```
