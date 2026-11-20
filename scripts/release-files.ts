/** VERIFIED: The release ZIP takes Git's view of the source plus the build, evidence and vendor folders Git ignores. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// .gitignore already keeps secrets, caches and runtime state out of Git, so the ZIP reuses it instead of a second list.
// These ignored folders hold the build, the evidence and the pinned tarballs that setup and the benchmarks verify.
const deliverables = ['dist', 'validation', 'vendor'];

function walk(root: string, dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(root.length + 1));
}

/** Sorted root-relative files for a release of version whose tarball has digest packedHash. */
export function releaseFiles(root: string, version: string, packedHash: string): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0');
  const files = new Set([...listed, ...deliverables.flatMap((dir) => walk(root, dir))]);
  return [...files]
    .filter((file) => {
      if (!file || file === 'SHA256SUMS') return false;
      try {
        // Symlinks would point outside the archive; deleted tracked files have no content.
        if (!lstatSync(join(root, file)).isFile()) return false;
      } catch {
        return false;
      }
      if (!file.startsWith('validation/')) return true;
      if (file.endsWith('.tgz')) return file === `validation/defuss-mcp-${version}.tgz`;
      if (file.endsWith('-repeat.json'))
        return JSON.parse(readFileSync(join(root, file), 'utf8')).environment.packageSha256 === packedHash;
      return true;
    })
    .sort();
}
