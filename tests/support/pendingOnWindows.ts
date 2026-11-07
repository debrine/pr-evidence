/**
 * The one list of tests that cannot pass on Windows yet, grouped by the reason.
 * A ticket that makes a test pass there removes it from this list.
 */
export interface PendingGroup {
  reason: string;
  /** Test file, relative to the repo root, mapped to the full test names in it. */
  tests: Record<string, string[]>;
}

export const pendingOnWindows: PendingGroup[] = [
  {
    reason: "Starting and stopping the app relies on POSIX `sh`, `ps` and process groups. See #19.",
    tests: {
      "tests/appRunner.test.ts": [
        "app runner > returns a bounded verbose log tail and cleans up after exit",
        "app runner > returns a bounded verbose log tail and cleans up after timeout",
        "app runner > probes external and configured apps without newer Node cancellation APIs",
        "app runner > removes startup signal handlers after readiness succeeds",
        "app runner > cleans up the app if recording ownership fails",
        "app runner > cleans up owned startup when readiness is interrupted by SIGINT",
        "app runner > cleans up owned startup when readiness is interrupted by SIGTERM",
        "app runner > starts the configured app, waits until it is ready, and stop stops it",
        "app runner > stops a whole process tree, not only the shell that launched it",
        "app runner > fails with the app's output when the app exits before it is ready",
        "app runner > fails with the app's output and leaves nothing running when the ready wait times out",
        "app runner > stops an app left over from an earlier run before starting a new one",
        "app runner > isolates ownership and same-commit evidence for different hosts",
        "app runner > isolates ownership and same-commit evidence for remote-less repositories",
        "app runner > isolates ownership and same-commit evidence for relative filesystem origins",
        "app runner > isolates ownership and same-commit evidence for dot-relative filesystem origins",
        "app runner > isolates ownership and same-commit evidence for https endpoint ports",
        "app runner > isolates ownership and same-commit evidence for http endpoint ports",
        "app runner > isolates ownership and same-commit evidence for ssh endpoint ports",
        "app runner > rejects an exited zero-status launcher before-probe even if its detached server answers",
        "app runner > rejects an exited zero-status launcher during-probe even if its detached server answers",
        "app runner > clears ownership after failed startup cleanup",
        "app runner > prunes expired ownership after the app exits naturally but keeps live apps",
        "app runner > keeps runs in separate worktrees of one repo apart",
        "finish > stops the app it started, even when the results are rejected",
      ],
      "tests/checkoutOwnership.test.ts": [
        "checkout ownership > ignores a replaced run through a stale checkout pointer during stop",
        "checkout ownership > ignores a replaced run through a stale checkout pointer during finish",
      ],
    },
  },
  {
    reason: "`commandPrefix` is POSIX shell syntax, and the `browser` command replaces it. See #16.",
    tests: {
      "tests/start.test.ts": ["start > returns a valid, deterministic browser session per repository"],
    },
  },
];
