/** VERIFIED: The installed CLI entry reads types without executing modules and leaves good output intact on failure. */
import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateContracts } from '../bin/generate.mjs';

it('compiles imported types and JSDoc, checks drift, and rejects ambiguous or recursive contracts atomically', async () => {
  mkdirSync('tmp', { recursive: true });
  const dir = mkdtempSync(resolve('tmp', 'contracts-'));
  const entry = resolve(dir, 'math.mts'),
    out = resolve(dir, 'math.mcp.mts');
  const run = (...extra: string[]) => generateContracts(['--entry', entry, '--out', out, ...extra]);
  try {
    writeFileSync(
      resolve(dir, 'types.mts'),
      'export interface Packet { data: Uint8Array; mode?: "a"|"b"; note: string|null; }',
    );
    writeFileSync(
      entry,
      `import type { Packet } from './types.mjs';
      throw new Error('The compiler must never execute the input.');
      /** Inspect a packet.
       * @param packet Input packet.
       * @returns The original bytes.
       */
      export async function inspect(packet: Packet, scale=1, ...more:number[]):Promise<Uint8Array> {void scale; void more;return packet.data;}
      export function unavailable<T>(t:T):T{return t;}
    `,
    );
    await run('--only', 'inspect');
    const original = readFileSync(out, 'utf8');
    const literal = original.split('const __contracts = ')[1]!.split(' satisfies Record')[0]!;
    const c = JSON.parse(literal).inspect;
    expect(c.parameters).toEqual(['packet', 'scale', 'more']);
    expect(c.rest).toBe('more');
    expect(c.inputSchema.required).toEqual(['packet']);
    expect(c.inputSchema.properties.packet.properties).toMatchObject({
      data: { contentEncoding: 'base64' },
      mode: { enum: ['a', 'b'] },
      note: { type: ['string', 'null'] },
    });
    expect(c.outputSchema.properties.value.description).toBe('The original bytes.');
    await run('--only', 'inspect', '--check');
    await expect(run()).rejects.toThrow('generic');
    expect(readFileSync(out, 'utf8')).toBe(original);
    writeFileSync(entry, 'interface Loop { child?: Loop }\nexport function inspect(p:Loop){return p;}');
    await expect(run()).rejects.toThrow('unsupported type');
    expect(readFileSync(out, 'utf8')).toBe(original);
    writeFileSync(entry, 'export function inspect(x:number){return x+1;}');
    await expect(run('--check')).rejects.toThrow('Stale');
    expect(readFileSync(out, 'utf8')).toBe(original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

it('compiles aliases, documented properties, literal unions and void using an explicit project', async () => {
  const dir = mkdtempSync(resolve('tmp', 'contract-signatures-'));
  const path = (name: string) => resolve(dir, name),
    entry = path('types.cts'),
    out = path('gen/sidecar.mjs');
  const config = path('tsconfig.json');
  try {
    writeFileSync(config, JSON.stringify({ compilerOptions: { module: 'NodeNext', strict: true } }));
    writeFileSync(
      entry,
      `interface Args {
      /** Recording mode. */
      mode: 'one'|'two'|null;
      count: 1|2|null; toggle: boolean|null; ok?:boolean; one: true; off:false;
      bytes: number[]; name: string; literal: 'x'; value: 3; missing:null; yes:boolean;
    }
    export const revision = 1;
    export type Label = string;
    function run(input:Args):void {void input;}
    export {run as act};`,
    );
    await generateContracts(['--entry', entry, '--out', out, '--project', config]);
    const source = readFileSync(out, 'utf8');
    expect(source).toContain('../types.cjs');
    const c = JSON.parse(source.split('const __contracts = ')[1]!.split(';\nexport')[0]!).act;
    expect(c.inputSchema.properties.input.properties).toMatchObject({
      mode: { type: ['string', 'null'], enum: ['one', 'two', null], description: 'Recording mode.' },
      count: { type: ['number', 'null'], enum: [1, 2, null] },
      toggle: { type: ['boolean', 'null'] },
      bytes: { items: { type: 'number' } },
      one: { enum: [true] },
      off: { enum: [false] },
      missing: { type: 'null' },
    });
    expect(c.outputSchema.required).toEqual([]);
    // A type-stripping project imports the source module by its own extension.
    for (const option of ['allowImportingTsExtensions', 'rewriteRelativeImportExtensions']) {
      writeFileSync(
        config,
        JSON.stringify({ compilerOptions: { module: 'NodeNext', noEmit: true, [option]: true } }),
      );
      await generateContracts(['--entry', entry, '--out', out, '--project', config]);
      expect(readFileSync(out, 'utf8')).toContain('"../types.cts"');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('diagnoses project and signature errors without writing a sidecar', async () => {
  const dir = mkdtempSync(resolve('tmp', 'contract-errors-'));
  const entry = resolve(dir, 'input.mts'),
    out = resolve(dir, 'generated.mts'),
    cfg = resolve(dir, 'tsconfig.json');
  const run = (...args: string[]) => generateContracts(['--entry', entry, '--out', out, ...args]);
  try {
    await generateContracts(['--help']);
    await expect(generateContracts([])).rejects.toThrow('--entry');
    await expect(generateContracts(['--entry', entry, '--out', entry])).rejects.toThrow('separate');
    await expect(run('--project', cfg)).rejects.toThrow();
    writeFileSync(cfg, JSON.stringify({ compilerOptions: { target: 'invalid' } }));
    await expect(run('--project', cfg)).rejects.toThrow(/target/);
    writeFileSync(cfg, '{}');
    await expect(run()).rejects.toThrow('runtime source');
    for (const [source, reason] of [
      ['export const x:number="bad";', 'not assignable'],
      ['export default function fn(){return 1}', 'named export'],
      ['export function bad({x}:{x:number}){return x}', 'named parameters'],
      ['export function bad(x: string|boolean|null){return x}', 'unsupported type'],
      ['export function bad(x: string|number){return x}', 'unsupported type'],
      ['export function bad(x: { method():void }){return x}', 'unsupported type'],
      ['export const revision=1;', 'No matching'],
      ['export function bad(x: readonly [string,number]){return x}', 'unsupported type'],
    ]) {
      writeFileSync(entry, source!);
      await expect(run()).rejects.toThrow(reason!);
    }
    writeFileSync(entry, 'export function valid(x:number){return x}');
    await expect(run('--only', 'valid,absent')).rejects.toThrow('No matching');
    await expect(run('--check')).rejects.toThrow('ENOENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
