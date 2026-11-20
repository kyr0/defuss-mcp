/** VERIFIED: make coverage reruns the Bun suite on Node, the package's other runtime, where V8 also counts branches. Coverage includes the runtime and compiler implementation; packed subprocess compatibility is verified independently. */
import { defineConfig } from 'vitest/config';
export default defineConfig({
  // Bunway publishes extensionless internal ESM imports; Vite resolves these for the Node source tests.
  ssr: { noExternal: ['bunway'] },
  test: {
    reporters: ['default', ['json', { outputFile: 'output/unit-tests.json' }]],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'bin/generate.mjs'],
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: 'output/coverage',
      thresholds: { lines: 99, branches: 95, statements: 98, functions: 97 },
    },
  },
});
