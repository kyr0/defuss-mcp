/** VERIFIED: One client contract drives the matrix assertion and the gate's check of its evidence. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Server runtime and HTTP provider pairs; child means a stdio subprocess. */
export const SERVERS = [
  ['node', 'express'],
  ['bun', 'express'],
  ['bun', 'bunway'],
  ['bun', 'fetch'],
] as const;
const CHILDREN = [
  ['node', 'child'],
  ['bun', 'child'],
] as const;
/** Every supported MCP client with the protocol eras it must negotiate. */
export const CLIENT_ERAS: Record<string, readonly string[]> = {
  node: ['auto', 'legacy'],
  bun: ['auto', 'legacy'],
  python: ['auto', 'legacy'],
  go: ['sdk-default'],
  'inspector-cli': ['cli-default'],
};
export interface Cell {
  server?: unknown;
  provider?: unknown;
  client?: unknown;
  era?: unknown;
  mode?: unknown;
}
const id = (c: Cell) => [c.server, c.provider, c.client, c.era, c.mode].join(' ');

/** Missing, unexpected and duplicate cells of an e2e run against the full or smoke contract. */
export function coverage(rows: readonly Cell[], smoke = false) {
  const expected = new Set<string>();
  for (const [server, provider] of smoke ? SERVERS.slice(0, 1) : [...SERVERS, ...CHILDREN])
    for (const [client, eras] of Object.entries(CLIENT_ERAS))
      for (const era of eras)
        for (const mode of provider === 'child' ? ['stdio'] : ['auto', 'json', 'sse'])
          expected.add(id({ server, provider, client, era, mode }));
  const actual = rows.map(id);
  return {
    expected: expected.size,
    missing: [...expected].filter((cell) => !actual.includes(cell)),
    extra: actual.filter((cell) => !expected.has(cell)),
    duplicates: actual.filter((cell, i) => actual.indexOf(cell) !== i),
  };
}

// The gate runs this after e2e, or with e2e reused. Check that evidence against the tarball packed now.
if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const root = resolve(import.meta.dirname, '..');
  const { environment, rows } = JSON.parse(readFileSync(join(root, 'output/e2e.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'defuss-mcp-pack-'));
  let digest: string;
  try {
    execFileSync('bun', ['pm', 'pack', '--quiet', '--destination', dir], { cwd: root, stdio: 'ignore' });
    const archive = readdirSync(dir).find((name) => name.endsWith('.tgz'))!;
    digest = createHash('sha256').update(readFileSync(join(dir, archive))).digest('hex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const result = coverage(rows);
  const problems = [
    ...(environment.packageSha256 === digest ? [] : ['output/e2e.json tested another tarball; run make e2e']),
    ...result.missing.map((cell) => 'missing ' + cell),
    ...result.extra.map((cell) => 'unexpected ' + cell),
    ...result.duplicates.map((cell) => 'duplicate ' + cell),
  ];
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(
    `${result.expected} client cells passed on the current tarball: ${Object.keys(CLIENT_ERAS).join(', ')} × ` +
      `${SERVERS.length} HTTP servers in 3 reply modes and ${CHILDREN.length} stdio children`,
  );
}
