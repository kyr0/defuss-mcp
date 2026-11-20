/** VERIFIED: A release archive excludes gitignored secrets and stale evidence but keeps the build and current evidence. */
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { releaseFiles } from '../scripts/release-files.ts';

it('selects Git-visible sources, the build and evidence of the packed version only', () => {
  mkdirSync('tmp', { recursive: true });
  const root = mkdtempSync(resolve('tmp', 'release-'));
  const write = (file: string, text = '') => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), text);
  };
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    write('.gitignore', 'dist/\nvalidation/\nvendor/\nnode_modules/\n.env*\n!.env.example\n');
    for (const file of ['README.md', '.env.example', '.vae/MEMORY.md', 'dist/index.mjs', 'validation/e2e.json', 'vendor/a.tgz'])
      write(file);
    // Research credentials, a local secret, dependencies and a stale manifest stay out.
    for (const file of ['.env', '.vae/.env.openai', 'node_modules/p/index.js', 'SHA256SUMS']) write(file, 'x');
    write('validation/defuss-mcp-1.0.0.tgz');
    write('validation/defuss-mcp-0.9.0.tgz');
    write('validation/fresh-repeat.json', JSON.stringify({ environment: { packageSha256: 'abc' } }));
    write('validation/stale-repeat.json', JSON.stringify({ environment: { packageSha256: 'old' } }));
    symlinkSync('README.md', resolve(root, 'link.md'));
    expect(releaseFiles(root, '1.0.0', 'abc')).toEqual([
      '.env.example',
      '.gitignore',
      '.vae/MEMORY.md',
      'README.md',
      'dist/index.mjs',
      'validation/defuss-mcp-1.0.0.tgz',
      'validation/e2e.json',
      'validation/fresh-repeat.json',
      'vendor/a.tgz',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
