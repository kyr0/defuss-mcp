/** VERIFIED: Install the vendored VAE source at its immutable, verified revision. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const source = 'vendor/defuss-vae-dc0f6b5.tar.gz';
const digest = '2f7d18bd65e76f76bc060cf9a36cd92295d37f233f1a5423644736bf22e24a08';
if (createHash('sha256').update(readFileSync(source)).digest('hex') !== digest) {
  console.error('VAE archive checksum mismatch.');
  process.exit(1);
}
mkdirSync('tmp/vae', { recursive: true });
// -m stamps extraction time, so make sees the runtime as newer than its archive.
execFileSync('tar', [
  '-xzmf',
  source,
  '-C',
  'tmp/vae',
  '--strip-components=1',
  'defuss-vae-dc0f6b5ea4973b2f3224a589d38c19386126e09d/plugin',
]);
