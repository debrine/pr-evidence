# pr-evidence

Test a branch in a real browser and post screenshots and a GIF as evidence on its pull request.

You ask your coding agent to gather evidence. It works out what to test from the diff, the PR description and the ticket, and you approve the list. It then drives a real browser against your running app and judges each criterion. You review the evidence, and one comment on the PR is created or updated.

The tool only reports. It never changes the code under test.

Web apps only, on github.com and `*.ghe.com`. macOS and Linux.

## Install

```sh
npx pr-evidence setup
```

This installs the skill at user level for each agent it finds, and tells you if a prerequisite is missing:

| Agent | Skill location |
| --- | --- |
| Claude Code | `~/.claude/skills/pr-evidence` |
| Codex | `~/.agents/skills/pr-evidence` |
| Cursor | `~/.cursor/skills/pr-evidence` |

Use `--agent claude`, `--agent codex` or `--agent cursor` to choose instead.

You need Node 20 or later, the [GitHub CLI](https://cli.github.com) logged in with `gh auth login`, and `chrome-devtools-axi` (`npm install -g chrome-devtools-axi`). You do not need ffmpeg or ImageMagick.

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

Without a config, pass `--url` to test an app that is already running or a preview deployment.

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

Evidence is saved in `~/.pr-evidence/<repo>/<sha>/` and pruned after 14 days. If the branch has no PR yet, it stays there until you run `npx pr-evidence publish`.

## Helper commands

The skill runs these for you. Each prints one JSON document. The exit code is 0 for success, 1 when a criterion failed and 2 when the tool itself failed.

| Command | Purpose |
| --- | --- |
| `setup` | Install the skill and check prerequisites |
| `start` | Begin a run for the current commit |
| `finish --results <file>` | Stop the app, record results and build the GIF |
| `stop` | Abandon a run |
| `publish` | Upload the latest finished run and update its PR comment |

## How the upload works

GitHub has no documented API for this. The upload uses the endpoint behind the comment box, authenticated with your `gh` token, so it could change without notice. `npm run test:smoke` checks it with one real upload, which cannot be deleted afterwards.

The upload contract follows [no-mistakes](https://github.com/kunchenguid/no-mistakes) (MIT).

## Development

```sh
npm install
npm test
npm run typecheck
```

Tests run the built CLI as a black box, against real git repos, a real HTTP server and a local fake of GitHub.
