// Stands in for chrome-devtools-axi. It prints what reached it as JSON on stdout, writes a
// line to stderr, and exits with FAKE_BROWSER_EXIT_CODE, so tests can see all three pass through.
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), env: process.env }));
process.stderr.write("fake browser stderr\n");
process.exitCode = Number(process.env.FAKE_BROWSER_EXIT_CODE ?? 0);
