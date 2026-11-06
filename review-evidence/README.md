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
