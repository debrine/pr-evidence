/**
 * The one list of tests that cannot pass on Windows yet, grouped by the reason.
 * A ticket that makes a test pass there removes it from this list.
 */
interface PendingGroup {
  reason: string;
  /** Test file, relative to the repo root, mapped to the full test names in it. */
  tests: Record<string, string[]>;
}

export const pendingOnWindows: PendingGroup[] = [
  {
    reason: "`commandPrefix` is POSIX shell syntax, and the `browser` command replaces it. See #16.",
    tests: {
      "tests/start.test.ts": ["start > returns a valid, deterministic browser session per repository"],
    },
  },
];
