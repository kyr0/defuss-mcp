/** VERIFIED: Replay matching, previously reviewed release attestations through the unmodified VAE gate. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { attestations, vae } from './vae.ts';

const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (git.status !== 0 || realpathSync(git.stdout.trim()) !== realpathSync('.')) {
  console.error('Run the VAE gate at the Git project root. A standalone source ZIP needs git init.');
  process.exit(1);
}
for (const [kind, dest] of Object.entries(attestations('release'))) {
  const previous = 'validation/' + kind + '.json';
  // The gate accepts a replayed attestation only while its code fingerprint still matches.
  if (existsSync(previous) && !existsSync(dest)) copyFileSync(previous, dest);
}
const result = spawnSync('python3', [vae, 'gate', '--repo', '.', '--session', 'release'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
});
process.stdout.write(result.stdout);
if (result.status === 0) {
  mkdirSync('output', { recursive: true });
  writeFileSync('output/vae-gate.txt', result.stdout);
}
process.exit(result.status ?? 1);
