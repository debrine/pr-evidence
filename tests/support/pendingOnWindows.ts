/**
 * The one list of tests that cannot pass on Windows yet, grouped by the reason.
 * A ticket that makes a test pass there removes it from this list.
 */
interface PendingGroup {
  reason: string;
  /** Test file, relative to the repo root, mapped to the full test names in it. */
  tests: Record<string, string[]>;
}

export const pendingOnWindows: PendingGroup[] = [];
