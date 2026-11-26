# Upgrading

## Upgrading from 0.2

The evidence comment has a more compact layout, with no change to how you run the tool or write `results.json`. The results table is gone. Each criterion is numbered and marked ✅ Pass or ❌ Fail, with a rule between criteria, and screenshots show as thumbnails you click to open full size. Publishing an earlier run again posts it in the new layout. See [What the comment shows](publishing.md#what-the-comment-shows).

## Upgrading from 0.1

Run `npx pr-evidence@latest setup` once after upgrading, or `npx.cmd pr-evidence@latest setup` on Windows. `@latest` stops `npx` reusing a cached 0.1 copy. Earlier versions ran every helper command through `npx`. `setup` installs the helper and rewrites the skill to call it directly. A `chrome-devtools-axi` you installed yourself is no longer used.

The evidence comment now shows each criterion with its own screenshots, and no longer has a GIF. See [What the comment shows](publishing.md#what-the-comment-shows).

- Evidence gathered with 0.1 but not published can't be published with 0.2. `publish` refuses it with `run_outdated`. Run the branch again.
- If you write `results.json` by hand, each criterion now takes `screenshots`, a list of file names that can be empty, in place of `screenshot`. `finish` rejects the old field.
