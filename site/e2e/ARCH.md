# Site browser suite

serve.ts serves docs/ as GitHub Pages does: directory index files, and 404.html for unknown paths. site.test.ts drives Chromium, Firefox and WebKit through Playwright against that server, runs the demo end to end, and records each engine and test in output/site-e2e.json.
