# Upgrading

## Upgrading from 0.1

Run `npx pr-evidence@latest setup` once after upgrading, or `npx.cmd pr-evidence@latest setup` on Windows. `@latest` stops `npx` reusing a cached 0.1 copy. Earlier versions ran every helper command through `npx`. `setup` installs the helper and rewrites the skill to call it directly. A `chrome-devtools-axi` you installed yourself is no longer used.
