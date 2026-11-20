/** VERIFIED: The pinned VAE runtime owns session folders, so attestation paths come from its own module. */
import { execFileSync } from 'node:child_process';

const scripts = 'tmp/vae/plugin/scripts';
export const vae = scripts + '/vae.py';
/** Review and docs attestation paths of one VAE session, creating its folder as VAE does. */
export function attestations(session: string): Record<'review' | 'docs', string> {
  const code = [
    'import json, sys',
    'from pathlib import Path',
    'sys.path.insert(0, sys.argv[1])',
    'from vae_state import attestation_path',
    'print(json.dumps({k: str(attestation_path(Path.cwd(), sys.argv[2], k)) for k in ("review", "docs")}))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code, scripts, session], { encoding: 'utf8' }));
}
