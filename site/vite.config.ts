import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { pages } from './build/pages.ts';

// VERIFIED: (site e2e) The demo imports the package by name, as an application would. The aliases
// resolve those names to this repository's build (make build), so the page runs
// the code a release ships, not the sources.
const dist = (file: string) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));

export default defineConfig({
  publicDir: 'public',
  // Relative asset URLs, so docs/index.html also renders when opened from disk.
  base: './',
  resolve: {
    alias: [
      { find: /^defuss-mcp\/(http|client|validation)$/, replacement: dist('$1.mjs') },
      { find: /^defuss-mcp$/, replacement: dist('index.mjs') },
    ],
  },
  build: {
    // GitHub Pages serves the repository's docs/ folder. Its Markdown pages belong to
    // the npm package, so build/pages.ts removes only the files this build writes.
    outDir: '../docs',
    emptyOutDir: false,
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  server: { fs: { allow: ['..'] } },
  plugins: [pages()],
});
