/** VERIFIED: Base64 preserves every visible byte of a view across JSON transports. Decoding checks size before allocation. */
import { DSON } from 'defuss-dson';
import type { InputSchema } from './index.js';

// Node and Bun expose Buffer, whose native base64 and UTF-8 length are the fastest paths there.
// Browsers, Deno and Workers lack it, so the same codec falls back to web-standard primitives.
interface NodeBuffer {
  from(buffer: ArrayBufferLike, byteOffset: number, length: number): { toString(encoding: 'base64'): string; write(text: string, encoding: 'base64'): number };
  byteLength(text: string): number;
}
interface Base64View extends Uint8Array {
  toBase64?: () => string;
  setFromBase64?: (text: string) => unknown;
}
const nodeBuffer = (globalThis as { Buffer?: NodeBuffer }).Buffer;
const utf8 = new TextEncoder();
/** UTF-8 byte length of a string without retaining an encoded copy on Node and Bun. */
export const utf8Length = nodeBuffer
  ? (text: string) => nodeBuffer.byteLength(text)
  : (text: string) => utf8.encode(text).byteLength;
function toBase64(view: Base64View): string {
  if (nodeBuffer) return nodeBuffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
  if (view.toBase64) return view.toBase64();
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000)
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}
/** The caller has already checked the canonical alphabet, padding and decoded length. */
function writeBase64(text: string, target: Base64View) {
  if (nodeBuffer) nodeBuffer.from(target.buffer, target.byteOffset, target.byteLength).write(text, 'base64');
  else if (target.setFromBase64) target.setFromBase64(text);
  else {
    const binary = atob(text);
    for (let i = 0; i < binary.length; i++) target[i] = binary.charCodeAt(i);
  }
}

export const compactKey = 'org.defuss.mcp/compact-v1';
export const defaultByteLimit = 16 * 1024 * 1024;
export const bytesSchema: InputSchema = {
  type: 'object',
  properties: {
    bytes: { type: 'string', contentEncoding: 'base64', description: 'Standard padded base64 bytes.' },
  },
  required: ['bytes'],
  additionalProperties: false,
};
export function checkByteLimit(maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('maxBytes must be a nonnegative safe integer.');
}
/** Only the selected byteOffset and byteLength are visible to the peer. */
export function encodeBytes(data: Uint8Array, maxBytes = defaultByteLimit): { bytes: string } {
  checkByteLimit(maxBytes);
  if (!(data instanceof Uint8Array)) throw new TypeError('Expected Uint8Array or Buffer.');
  if (data.byteLength > maxBytes) throw new RangeError('Binary payload exceeds the decoded byte limit.');
  return { bytes: toBase64(data) };
}
/** Node's native decoder accepts malformed input. Check the alphabet, padding and unused bits first. */
export function decodeBytes(envelope: unknown, maxBytes = defaultByteLimit): Uint8Array<ArrayBuffer> {
  checkByteLimit(maxBytes);
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !Object.hasOwn(envelope, 'bytes') ||
    Object.keys(envelope).length !== 1
  )
    throw new TypeError('Send exactly one bytes field containing canonical padded base64.');
  const str = (envelope as { bytes: unknown }).bytes;
  if (typeof str !== 'string' || str.length % 4 !== 0) throw new TypeError('Use canonical padded base64.');
  const pad = str.endsWith('==') ? 2 : str.endsWith('=') ? 1 : 0;
  const len = (str.length / 4) * 3 - pad;
  if (len > maxBytes) throw new RangeError('Binary payload exceeds the decoded byte limit.');
  const chars = str.length - pad;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (
    /[^A-Za-z0-9+/]/.test(pad ? str.slice(0, chars) : str) ||
    (pad && (alphabet.indexOf(str[chars - 1]!) & (pad === 2 ? 15 : 3)) !== 0)
  )
    throw new TypeError('Use canonical padded base64.');
  // Decode into an exact-length backing array, including tiny values that Buffer.from would pool.
  const result = new Uint8Array(len);
  writeBase64(str, result);
  return result;
}
function scalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0))
  );
}
interface NumericViewConstructor {
  readonly name: string;
  readonly prototype: object;
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer): ArrayBufferView;
}
const numericViews: NumericViewConstructor[] = [
  Int8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
];
// Float16Array is absent on older supported Node versions. Register only a native constructor.
const float16 = (globalThis as typeof globalThis & { Float16Array?: NumericViewConstructor }).Float16Array;
if (float16) numericViews.push(float16);
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
// Only big-endian hosts reach this: the wire order of numeric views is little-endian.
function swapWords(bytes: Uint8Array, width: number) {
  for (let i = 0; i < bytes.length; i += width) bytes.subarray(i, i + width).reverse();
}
function byteView(value: object): { view: Uint8Array; kind?: string; width: number } | undefined {
  if (value instanceof Uint8Array) return { view: value, width: 1 };
  if (value instanceof ArrayBuffer) return { view: new Uint8Array(value), kind: 'ArrayBuffer', width: 1 };
  if (!ArrayBuffer.isView(value)) return;
  const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof DataView) return { view, kind: 'DataView', width: 1 };
  const ctor = numericViews.find((type) => Object.getPrototypeOf(value) === type.prototype);
  if (ctor) return { view, kind: ctor.name, width: ctor.BYTES_PER_ELEMENT };
}
// A record wrapper keeps application keys (including "bytes" and "__proto__") distinct from wire tags.
// Larger or aliased graphs retain the original DSON representation.
const maxNodes = 4096,
  maxDepth = 32;
const unsupported = Symbol('use DSON');
type Budget = { nodes: number; remaining: number };
function encodeTree(value: unknown) {
  const seen = new Set<object>();
  const pending: { view: Uint8Array; width: number; envelope: { bytes: string; kind?: string } }[] = [];
  let nodes = 0,
    bytes = 0;
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > maxNodes || depth > maxDepth) return unsupported;
    if (scalar(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) return unsupported;
    seen.add(item);
    const binary = byteView(item);
    if (binary) {
      bytes += binary.view.byteLength;
      if (bytes > defaultByteLimit) return unsupported;
      const envelope = binary.kind ? { bytes: '', kind: binary.kind } : { bytes: '' };
      pending.push({ ...binary, envelope });
      return envelope;
    }
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    if (!array && proto !== Object.prototype && proto !== null) return unsupported;
    if (array && (proto !== Array.prototype || item.length > maxNodes - nodes)) return unsupported;
    // A callable toJSON opts into DSON serialization. A data field named toJSON is ordinary JSON.
    const serializer = Object.getOwnPropertyDescriptor(item, 'toJSON');
    if (serializer && (!('value' in serializer) || typeof serializer.value === 'function'))
      return unsupported;
    const keys = Object.keys(item);
    if (keys.length > maxNodes - nodes || (array && keys.length !== item.length)) return unsupported;
    const children: unknown[] = [];
    const record: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (array && key !== String(children.length)) return unsupported;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in descriptor)) return unsupported;
      const child = visit(descriptor.value, depth + 1);
      if (child === unsupported) return unsupported;
      if (array) children.push(child);
      else record[key] = child;
    }
    return array ? children : { record };
  }
  const tree = visit(value, 0);
  // Delay native base64 conversion until eligibility and alias checks for the whole graph pass.
  if (tree !== unsupported)
    for (const { view, width, envelope } of pending) {
      const canonical = !littleEndian && width > 1 ? new Uint8Array(view) : view;
      if (canonical !== view) swapWords(canonical, width);
      envelope.bytes = encodeBytes(canonical).bytes;
    }
  return tree;
}
function unpackTree(item: unknown, budget: Budget, depth: number): unknown {
  if (++budget.nodes > maxNodes || depth > maxDepth) throw new RangeError('Compact tree limit exceeded.');
  if (scalar(item)) return item;
  if (Array.isArray(item)) {
    if (item.length > maxNodes - budget.nodes) throw new RangeError('Compact array limit exceeded.');
    return item.map((child) => unpackTree(child, budget, depth + 1));
  }
  if (!item || typeof item !== 'object') throw new TypeError('Invalid compact value.');
  if (Object.hasOwn(item, 'kind') && Object.hasOwn(item, 'bytes') && Object.keys(item).length === 2) {
    const { kind, bytes: encoded } = item as { kind: unknown; bytes: unknown };
    const ctor = numericViews.find((type) => type.name === kind);
    if (!ctor && kind !== 'DataView' && kind !== 'ArrayBuffer')
      throw new TypeError('Unknown binary view type.');
    const bytes = decodeBytes({ bytes: encoded }, budget.remaining);
    budget.remaining -= bytes.byteLength;
    if (!ctor) return kind === 'DataView' ? new DataView(bytes.buffer) : bytes.buffer;
    if (bytes.byteLength % ctor.BYTES_PER_ELEMENT) throw new TypeError('Invalid binary view length.');
    if (!littleEndian && ctor.BYTES_PER_ELEMENT > 1) swapWords(bytes, ctor.BYTES_PER_ELEMENT);
    return new ctor(bytes.buffer);
  }
  if (Object.keys(item).length !== 1) throw new TypeError('Invalid compact value.');
  if (Object.hasOwn(item, 'record')) {
    const record = (item as { record: unknown }).record;
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new TypeError('Invalid compact record.');
    // fromEntries creates own data properties even for "__proto__".
    const keys = Object.keys(record);
    if (keys.length > maxNodes - budget.nodes) throw new RangeError('Compact record limit exceeded.');
    return Object.fromEntries(
      keys.map((key) => [key, unpackTree((record as Record<string, unknown>)[key], budget, depth + 1)]),
    );
  }
  const bytes = decodeBytes(item, budget.remaining);
  budget.remaining -= bytes.byteLength;
  return bytes;
}
export function unpackValue(value: unknown) {
  return unpackTree(value, { nodes: 0, remaining: defaultByteLimit }, 0);
}
export function packArguments(args: unknown[]): { packed: unknown[] } | { dson: string } {
  if (args.length < maxNodes && args.every(scalar)) return { packed: args };
  const tree = encodeTree(args);
  return tree === unsupported ? { dson: DSON.stringify({ args }) } : { packed: tree as unknown[] };
}
export function unpackArguments(packed: unknown): unknown[] {
  if (!Array.isArray(packed)) throw new TypeError('Supply a packed positional array.');
  if (packed.length < maxNodes && packed.every(scalar)) return packed;
  return unpackValue(packed) as unknown[];
}
export function packValue(value: unknown): Record<string, unknown> {
  if (scalar(value)) return { value };
  if (value instanceof Uint8Array && value.byteLength <= defaultByteLimit) return encodeBytes(value);
  const tree = encodeTree(value);
  return tree === unsupported ? { dson: DSON.stringify(value) } : { packed: tree };
}
