# Site build

The Vite plugin and its renderers run during the build only. pages.ts fills snippets, slots, charts and views, and owns the generated files in docs/. highlight.ts runs Shiki once per build. charts.ts turns the evidence snapshot into HTML bars and the client table. data.ts loads that snapshot and rejects one from another package version. llms.ts renders the agent text from the same snippets as the page.
