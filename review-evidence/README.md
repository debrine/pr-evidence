# Review fix evidence

R1-R3 were confirmed and fixed through the built CLI. The regression tests exercise persisted run records, actual app processes, retained screenshot files, CLI JSON output, and pruning.

Red command (before source changes):

```sh
npm test -- tests/appRunner.test.ts -t 'isolates ownership|recording ownership fails|clears ownership|prunes expired ownership'
```

Result: exit 1; five regressions failed for the reported reasons. [Full red output and user-visible CLI logs](red.log).

Green command (after all source changes and path tracing):

```sh
npm test -- tests/appRunner.test.ts tests/evidenceStore.test.ts tests/start.test.ts
```

Result: exit 0; 20 tests passed across the three affected files. [Full green output](green.log). The test reporter suppresses console output for passing tests; the red log records CLI responses, and the green assertions verify the corrected observable behavior.

Repository namespace isolation covers identical commits on different hosts and independent remote-less repositories with identical directory names. Both preserve the first app and its evidence after starting and stopping the second repository. A fault-injection preload simulates an ownership-record filesystem write failure; a test watchdog bounds the CLI's lifetime so the red run can observe and clean up the leaked app. This simulates the write failure rather than filling the disk. Other regressions verify failed-start ownership removal and expired-run pruning after app exit, including preservation while the app remains alive.

Assumptions and delivery context:

- Remote identities now use a digest of host, owner, and name; local identities use Git's absolute common directory. No migration of the previous ambiguous evidence namespace is included. Existing records in that namespace remain eligible for global pruning.
- Per-worktree isolation, finish, publish, setup, and the skill remain deferred.
- Retain ghToken/browserCli harness options, fake GitHub/browser executables, and the fake GitHub base URL by explicit user decision: stacked feat/publish and feat/skill-and-setup branches use them.
- Dependencies were initially absent; npm ci installed the locked project dependencies before the red run. No system packages or global configuration were changed.
- This review phase performs no complete-suite test/lint, push, PR creation, CI, or merge. The outer executor owns those phases and must open the PR against main with this evidence and context in its description. Never merge.

## Follow-up review: remote parsing, dirty state, foreground commands

Confirmed findings review-1, R5, and R6 at the shared boundaries. Filesystem origins no longer enter the network-identity parser. HTTP, HTTPS, and SSH nondefault ports are retained, while explicit default ports and scp-style SSH preserve the existing cross-transport repository identity. The clean-tree guard explicitly includes untracked files and all submodule changes regardless of display preferences. Startup rejects every observed launcher exit, including zero and signals, before accepting readiness or timing out; its error requires a foreground command. Existing ownership-write cleanup and liveness-aware pruning remain intact.

Red command, before implementation changes:

```sh
npm test -- tests/appRunner.test.ts tests/start.test.ts --silent=false
```

Result: exit 1; 13 failed and 18 passed. [Full red output and CLI logs](round-2-red.log). Twelve failures demonstrate the reported behavior; one before-probe fixture timed out because its detached server tried to send IPC after the launcher disconnected. The fixture was corrected to check the connection before sending. No implementation change preceded the corrected red reproduction:

```sh
npm test -- tests/appRunner.test.ts -t 'zero-status launcher before-probe' --silent=false
```

Result: exit 1; one failed, 22 skipped. The corrected fixture demonstrates an exited launcher incorrectly accepted as a successful start. [Corrected red output and CLI logs](round-2-before-probe-red.log).

After all implementation changes and tracing the failing and successful paths, the single focused green verification was:

```sh
npm test -- tests/appRunner.test.ts tests/start.test.ts tests/evidenceStore.test.ts --silent=false --disableConsoleIntercept
```

Result: exit 0; 34 tests passed across three affected files. [Full green output, including user-visible CLI logs](round-2-green.log). No complete repository test or lint suite was run in this review phase.

Coverage includes ownership and evidence isolation for identical relative filesystem origins and HTTP/HTTPS/SSH endpoints with different ports; default-port transport equivalence; dirty-state rejection and allowed-dirty output/records for hidden untracked files, modified submodule files, and untracked submodule files; zero, nonzero, and signal exits; and detached launchers that exit before a readiness probe or while a successful response is pending. The detached fixtures demonstrate that their servers remain outside ownership and are explicitly cleaned up by the test harness.

Foreground-only scope and limitations for the PR description:

- Configured start commands must remain in the foreground. Detached processes left behind by unsupported launchers are out of scope and are not discovered or managed. The error communicates this restriction.
- Exit checks cover startup, including an exit observed after a readiness request begins but before its response is accepted. Once the CLI has returned success, a later command exit cannot retroactively make that invocation fail. No ongoing supervisor or daemon ownership tracking was added. Normal later app exits remain covered by the existing pruning behavior.
- Filesystem origins use the existing Git-common-directory fallback, preserving the deferral of per-worktree isolation. Finish, publish, setup, and the skill remain deferred.
- The previous namespace migration limitation and explicit harness-retention decision above remain applicable. No earlier pipeline fix was reverted.
- The outer executor must open the PR against main and reference these evidence files, commands/results, CLI logs, assumptions, fixture challenge, and foreground/detached limitations in its description. Never merge.
