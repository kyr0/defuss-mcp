/** VERIFIED: Every authored source directory documents its boundary, including test drivers. */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';

const source = new Set(['.js', '.ts', '.mts', '.mjs', '.cjs', '.py', '.go']);
const files = ['bin', 'src', 'examples', 'tests', 'scripts', 'site'].flatMap((root) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.parentPath.split(sep).includes('node_modules'))
    .map((entry) => join(entry.parentPath, entry.name)),
);
files.push(...readdirSync('.', { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name));
const missing = [
  ...new Set(
    files
      .filter((file) => source.has(extname(file)) && !existsSync(join(dirname(file), 'ARCH.md')))
      .map((file) => join(dirname(file), 'ARCH.md')),
  ),
].sort();
if (missing.length) {
  console.error('Add architecture notes in ' + missing.join(', '));
  process.exit(1);
}
