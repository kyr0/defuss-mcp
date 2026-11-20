/** VERIFIED: The portable wire contract bounds byte allocations and preserves own property names. */
import { expect, it } from 'vitest';
import { bindContract, createMcpApi, decodeDson, encodeBytes } from '../src/index.js';
import { makeContractCodec, type WireSchema, type FunctionContract } from '../src/contracts.js';
import { unpackValue, unpackArguments, defaultByteLimit, packArguments } from '../src/binary.js';

const empty: WireSchema = { type: 'object' };
const contract = (schema: WireSchema): FunctionContract => ({
  parameters: ['field'],
  inputSchema: { type: 'object', properties: { field: schema }, required: ['field'] },
  outputSchema: empty,
});
it('rejects inconsistent signatures at registration and isolates bound schema snapshots', () => {
  const base = contract({ type: 'string' });
  for (const bad of [
    { ...base, parameters: [] },
    { ...base, rest: 'field' },
    { ...base, parameters: ['other'] },
    { ...base, outputSchema: { type: 'array' } },
    contract({ type: 'array' }),
    contract({ type: ['number', 'string'] as never }),
  ])
    expect(() => makeContractCodec(bad as FunctionContract, 'server')).toThrow();
  const fn = Object.freeze((field: string) => field);
  expect(bindContract(fn, base)).toBe(fn);
  expect(bindContract(fn, structuredClone(base))).toBe(fn);
  expect(() => bindContract(fn, contract({ type: 'number' }))).toThrow(/Conflicting/);
  expect(() => encodeBytes('x' as never)).toThrow(TypeError);
  for (const input of [null, 7, {}, { dson: [] }, { dson: '{' }]) expect(() => decodeDson(input)).toThrow();
  for (const opts of [
    { compile: 7 },
    {
      get onError() {
        throw Error('accessed');
      },
    },
  ])
    expect(() => createMcpApi({ name: 'x', version: '1' }, opts as never)).toThrow(/registry option/);
});
it('round-trips nullable enums, safe integers, arrays and prototype-named own fields', () => {
  const schema: WireSchema = {
    type: 'object',
    properties: {
      ['__proto__']: { type: 'array', items: { type: 'integer' } },
      'a~/': { type: ['string', 'null'], enum: ['yes', null] },
      none: { type: 'null' },
    },
  };
  const c = contract(schema);
  const send = makeContractCodec(c, 'client'),
    recv = makeContractCodec(c, 'server');
  for (const choice of ['yes', null]) {
    const value = { ['__proto__']: [-3], 'a~/': choice, none: null };
    const [restored] = recv.decodeArgs(send.encodeArgs([value]));
    expect(restored).toStrictEqual(value);
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
  }
  for (const [v, expected] of [
    [false, 'Supply an object'],
    [{ 'a~/': 'no' }, '/field/a~0~1'],
    [{ none: false }, '/field/none'],
    [{ ['__proto__']: true }, 'Supply an array'],
    [{ ['__proto__']: [0.5] }, '/field/__proto__/0'],
    [{ 'new/field': 12 }, '/field/new~1field'],
  ] as const)
    expect(() => send.encodeArgs([v])).toThrow(expected);
  expect(() => send.encodeArgs([{}, false])).toThrow(/extra positional/);
  expect(recv.encodeResult(undefined)).toEqual({});
  expect(send.decodeResult({})).toBeUndefined();
});
it('accounts for the aggregate byte budget in both conversion directions', () => {
  const c = contract({ type: 'array', items: { type: 'string', contentEncoding: 'base64' } });
  const send = makeContractCodec(c, 'client'),
    recv = makeContractCodec(c, 'server');
  const full = new Uint8Array(defaultByteLimit);
  expect(() => send.encodeArgs([[full, Uint8Array.of(0)]])).toThrow('/field/1: Reduce');
  expect(() => recv.decodeArgs({ field: [encodeBytes(full).bytes, 'AA=='] })).toThrow('/field/1: Reduce');
  expect(() => send.encodeArgs([['AA==']])).toThrow('/field/0: Supply a Uint8Array');
});
it('refuses oversized, ambiguous and misaligned compact trees before materializing them', () => {
  const nested = (depth: number) => {
    let v: unknown = 1;
    while (depth--) v = [v];
    return v;
  };
  for (const [wire, reason] of [
    [nested(34), 'tree limit'],
    [Array(4096).fill(null), 'array limit'],
    [
      { record: Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [String(i), null])) },
      'record limit',
    ],
    [{ bytes: 'AQ==', kind: 'Int16Array' }, 'view length'],
    [{ bytes: '', kind: 'Unrecognized' }, 'Unknown binary'],
    [undefined, 'compact value'],
    [{ record: [], bytes: '' }, 'compact value'],
    [{ record: [] }, 'compact record'],
  ] as const)
    expect(() => unpackValue(wire)).toThrow(reason);
  expect(() => unpackArguments({})).toThrow();
  const ordinary = { toJSON: 'data', bytes: Uint8Array.of(3) };
  const compact = packArguments([ordinary]);
  expect('packed' in compact && unpackArguments(compact.packed)).toStrictEqual([ordinary]);
  for (const input of [
    nested(34),
    Array(4100).fill(0),
    Object.assign([1], { meta: 7 }),
    {
      toJSON() {
        return 'data';
      },
    },
    Object.defineProperty({}, 'n', { enumerable: true, get: () => 1 }),
  ])
    expect(packArguments([input])).toHaveProperty('dson');
});

it('preserves empty contract calls and omits nested optional values set to undefined', () => {
  const c = makeContractCodec({ parameters: [], inputSchema: empty, outputSchema: empty }, 'client');
  expect(c.encodeArgs([])).toEqual({});
  const params = makeContractCodec(
    contract({ type: 'object', properties: { note: { type: 'string' } } }),
    'client',
  );
  expect(params.encodeArgs([{ note: undefined }])).toEqual({ field: {} });
});
it('falls back to DSON for graphs beyond the compact byte budget or with array extras', () => {
  const half = new Uint8Array(defaultByteLimit / 2 + 1);
  expect(packArguments([half, half.slice()])).toHaveProperty('dson');
  const extra = Object.assign([1, 2], { note: 'kept' });
  const packed = packArguments([{ list: extra }]);
  expect(packed).toHaveProperty('dson');
  expect(packArguments([Uint8Array.of(1)])).toHaveProperty('packed');
});
