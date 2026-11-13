# Publishing

What to check before you publish, where evidence is kept, and how the upload to GitHub works.

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

## Where evidence is kept

Evidence is saved in `~/.pr-evidence/<repository-key>/<sha>/`. On `start`, runs whose records have not changed in 14 days are pruned, except those with a live app owned by this tool. Running the same commit again replaces its earlier evidence. If the branch has no PR yet, the evidence is kept subject to that retention rule. After opening a PR, run the installed helper's `publish`, as shown in [Running a helper command yourself](reference.md#running-a-helper-command-yourself): it prefers a finished run for the checked-out commit, otherwise selects this checkout's latest run, which must be finished. It finds the PR using the selected run's saved branch and origin repository.

## Testing two branches with worktrees

To test two branches at once, use separate `git worktree` checkouts. Their apps and runs stay apart when testing different commits. The same commit can have only one unfinished run across checkouts: start exits 2 without changing evidence if another checkout owns that run. Finish it in its owning checkout first; starting the commit elsewhere then replaces its evidence. Stop and finish ignore runs owned by another checkout. Worktrees share a saved browser profile, so run the browser steps one at a time.

## How the upload works

GitHub has no documented API for this. The upload uses the endpoint behind the comment box, authenticated with your `gh` token, so it could change without notice. `npm run test:smoke` checks it with one real upload, which cannot be deleted afterwards.

PNG and GIF uploads must be nonempty and at most 10 MiB each. All files are uploaded before the PR comment is changed. If a later upload fails, earlier uploaded assets may remain even though the comment is untouched. A comment request failure can leave publication uncertain; inspect the PR before retrying.

The upload contract follows [no-mistakes](https://github.com/kunchenguid/no-mistakes) (MIT).
