# defuss-mcp website

The project site: a live MCP demo that runs the published package in the browser, the tested client matrix, measured performance, install examples and an API overview. It builds into the repository's `docs/` folder, which GitHub Pages can serve, next to the package's Markdown pages.

## Commands

Run from the repository root. The site bundles the package from `../dist`, so `make site` builds the package first.

```sh
make site                  # build the package, then the site into docs/
cd site && bun run dev     # Vite dev server with the same build-time rendering
bun site/e2e/serve.ts      # serve docs/ like GitHub Pages at http://127.0.0.1:4173/
make test                  # includes the site's renderer tests
make e2e                   # includes the site suite in Chromium, Firefox and WebKit
```

`bun run test:e2e` in `site/` runs the browser suite against an existing build and writes `output/site-e2e.json`.

## Editing content

- The copy lives in `index.html`. Markdown pages and this HTML pass the VAE prose check.
- Code windows are `<div class="mockup-code" data-snippet="id"></div>` placeholders. The code lives in `src/snippets.ts`, and Shiki highlights it at build time. `llms.txt` uses the same snippets through `{{snippet:id}}`.
- `{{slot}}` values come from `data/evidence.json`, which `make site-data` copies from the `make verify` and `make bench` evidence in `output/`. The build refuses a snapshot of another package version.
- `<!--chart:id-->` and `<!--table:clients-->` become HTML bar charts and the client table at build time.

See [ARCH.md](ARCH.md) for how the pieces fit together.
