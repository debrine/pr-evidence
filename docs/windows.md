# Windows

Windows is supported natively, from PowerShell or cmd. WSL is not needed.

- Run first-time setup with `npx.cmd pr-evidence setup`. It works even when PowerShell's execution policy blocks scripts. After that the skill runs `node.exe` directly, so the policy does not apply.
- Install [Git for Windows](https://git-scm.com/download/win). The start command runs with its `sh.exe`, found from `git --exec-path`, so the same `.pr-evidence.yml` and wrapper scripts work on every platform. `setup` reports it as missing if it cannot be found.
- If the repo has wrapper scripts, add `*.sh text eol=lf` to its `.gitattributes`. Otherwise Git can check them out with CRLF line endings, and `sh` fails on the carriage returns.
- The app is stopped with `taskkill /T`, then `taskkill /T /F` after 5 seconds.
- `taskkill` finds children by their parent at the moment it runs, so a process whose parent has already exited is missed and keeps running. For example, a wrapper script that starts a server with `&` and then exits leaves that server behind. End the script with `wait`, as in [Apps with several processes](configuration.md#apps-with-several-processes), and stop anything left over yourself. The tool does not stop processes by listening port, because that could stop an app it did not start.
- If the tool cannot confirm that a running process is the app it started, it reports `app_not_confirmed` and stops nothing. Stop the app yourself if it is still running.

To run a helper command yourself from PowerShell or cmd, see [Running a helper command yourself](reference.md#running-a-helper-command-yourself).
