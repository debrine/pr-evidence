# Reference

The exact options, commands and prerequisites.

## What setup installs

```sh
npx pr-evidence setup
```

On Windows, run `npx.cmd pr-evidence setup` instead. See [Windows](windows.md).

This installs the helper in `~/.pr-evidence/app/<version>/`, then installs the skill at user level for each agent it finds, and tells you if a prerequisite is missing:

| Agent | Skill location |
| --- | --- |
| Claude Code | `~/.claude/skills/pr-evidence` |
| Codex | `~/.agents/skills/pr-evidence` |
| Cursor | `~/.cursor/skills/pr-evidence` |

Use `--agent claude`, `--agent codex` or `--agent cursor` to choose instead.

## Prerequisites

- Node 20 or later, with npm
- Git. On Windows, Git for Windows, as described in [Windows](windows.md)
- On macOS and Linux, `sh`, `ps` and process group signals, as standard
- The [GitHub CLI](https://cli.github.com), logged in with `gh auth login`

`setup` installs a pinned `chrome-devtools-axi` with the helper, so you do not install it yourself. You do not need ffmpeg or ImageMagick.

## Options

Add these to your request, for example "Gather evidence for ABC-123 with --criteria "Saving twice does not create a duplicate"".

| Option | Effect |
| --- | --- |
| `--ticket <path or key>` | Use this ticket |
| `--criteria "<text>"` | Add a criterion (repeatable) |
| `--criteria-file <path>` | Add criteria from a file |
| `--url <url>` | Test an app that is already running |
| `--allow-dirty` | Run with uncommitted changes. The evidence is marked |
| `--yes` | Skip the review before publishing |

## Helper commands

The skill runs these for you. Each prints one JSON document. The exit code is 0 for success, 1 when a criterion failed and 2 when the tool itself failed.

| Command | Purpose |
| --- | --- |
| `setup` | Install the helper and the skill, and check prerequisites |
| `start` | Begin a run for the current commit |
| `finish --results <file>` | Stop the app and record results |
| `stop` | Abandon a run |
| `publish` | Publish saved evidence, as described in [Where evidence is kept](publishing.md#where-evidence-is-kept) |

`finish` fails with `screenshot_invalid`, and records nothing, if a screenshot is empty or over GitHub's 10 MiB image limit. It warns about each criterion that cites no screenshots. Review those warnings before publishing.

`publish` refuses a run finished by an earlier version with `run_outdated`. Run it again to publish it.

## Running a helper command yourself

The skill calls the installed helper as `node "<helperPath>"`, using the `helperPath` field that `setup` prints. To run a helper command yourself, use the same form, so you stay on the version your agent uses. Replace `<version>` with the version `setup` installed:

```sh
node ~/.pr-evidence/app/<version>/node_modules/pr-evidence/dist/cli.js publish
```

In PowerShell:

```powershell
node "$HOME\.pr-evidence\app\<version>\node_modules\pr-evidence\dist\cli.js" publish
```

In cmd:

```bat
node "%USERPROFILE%\.pr-evidence\app\<version>\node_modules\pr-evidence\dist\cli.js" publish
```
