# Contributing

## Development

```sh
npm install
npm test
npm run typecheck
```

To try a checkout, run `npm ci`, then `npm pack`, then `PR_EVIDENCE_INSTALL_SOURCE=/absolute/path/to/pr-evidence-<version>.tgz node dist/cli.js setup`. Without `PR_EVIDENCE_INSTALL_SOURCE`, `setup` installs the published release with the same version number, whatever the checkout contains. Run helper commands from the Git repository being tested.

The regular tests run the built CLI as a black box, against real git repos, a real HTTP server and a local fake of GitHub. The opt-in upload smoke test imports `src` directly. `npm run test:smoke:browser` drives real `chrome-devtools-axi` and real Chrome, and runs as the Windows smoke job in CI.

## Releasing

After `npm publish`, the registry can list the new version before its tarball is available. Until it is, `npx` fails with `could not determine executable to run`, and the tarball URL returns 404. For `0.1.0` this took about 8 minutes. Wait for this to succeed before testing the release:

```sh
curl -fsI "$(npm view pr-evidence@<version> dist.tarball)"
```
