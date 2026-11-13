# Configuration

How to tell pr-evidence how to start your app, and how it logs in.

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

## Apps with several processes

If the app needs setup steps or more than one process, commit a wrapper script and point `start` at it, for example `start: ./scripts/evidence-start.sh`. Do the setup first, then stay in the foreground:

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

Set `readyUrl` to the part that answers last. The script has two minutes to reach it. The tool stops the script and the processes it keeps in the foreground or starts with `&`. It does not stop services that run on their own, such as those from `docker compose up -d`, so stop them with `docker compose down`. `wait` keeps the script running if only one of its processes dies, so a failure there shows up in the app rather than in `start`.

On Windows, see [Windows](windows.md) for line endings and how processes are stopped.

## Testing an app that is already running

Without a config, pass `--url` to test an app that is already running or a preview deployment. An existing config is still validated, and the external app is never stopped by this tool.

For a one-off run of an app with several processes, start the stack yourself and pass `--url`. You then own the app and stop it afterwards.

## Logging in

By default you log in once by hand, in a browser profile kept for this tool, and runs reuse that session. MFA and SSO work, and the agent never sees your password. For simple apps, test credentials can come from the env vars named in the config instead.

The tool never uses your day-to-day browser profile.
