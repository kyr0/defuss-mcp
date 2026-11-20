/** VERIFIED: Function signatures survive in declaration files. The positional wire contract works with ordinary MCP clients. */
import { DSON } from 'defuss-dson';
import { utf8Length } from './binary.js';
import type { InputSchema, ToolContext } from './index.js';

/** Callable member accepted by a function collection. Concrete signatures survive in the inferred API. */
export type ApiFunction = (...args: never[]) => unknown;
/** Generators resolve to yielded items and the final return value. Other results retain their type. */
export type FunctionResult<R> =
  R extends AsyncGenerator<infer V, infer End, unknown>
    ? { items: V[]; result: End }
    : R extends Generator<infer V, infer End, unknown>
      ? { items: V[]; result: End }
      : R;
/** Remote calls preserve parameter types and return a promise of the materialized result. */
export type RemoteFunction<F> = F extends (...args: infer Args) => infer R
  ? (...args: Args) => Promise<FunctionResult<Awaited<R>>>
  : never;
export const bindingKey = 'org.defuss.mcp/binding';

export const collectionKey = 'org.defuss.mcp/collection';

export const positionalSchema: InputSchema = {
  type: 'object',
  properties: {
    packed: {
      type: 'array',
      description:
        'Negotiated compact arguments. Use args for ordinary JSON, or the binary tool for raw bytes.',
      items: {},
    },
    args: { type: 'array', items: {}, description: 'Positional arguments in declaration order.' },
    dson: { type: 'string', description: 'DSON.stringify({ args }) for lossless typed callers.' },
  },
  oneOf: [{ required: ['args'] }, { required: ['dson'] }, { required: ['packed'] }],
  additionalProperties: false,
};

interface Entry {
  name: string;
  key: string | number;
  receiver: unknown;
  fn: ApiFunction;
}

/** Inspect data descriptors only. Looking up properties dynamically can execute application getters. */
export function functionEntries(source: object): Entry[] {
  if (Array.isArray(source)) {
    const result: Entry[] = [];
    for (let key = 0; key < source.length; key++) {
      const fn = Object.getOwnPropertyDescriptor(source, key)?.value;
      if (typeof fn !== 'function' || !fn.name)
        throw new TypeError(
          'Array entries must be named functions. Use an object key to name an anonymous function.',
        );
      result.push({ key, name: fn.name, fn: fn as ApiFunction, receiver: undefined });
    }
    return result;
  }
  const proto = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError('Supply a plain function object or an array.');
  const result: Entry[] = [];
  for (const name of Object.keys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, name)!;
    if (!('value' in descriptor)) throw new TypeError('Function objects must use data properties: ' + name);
    const fn = descriptor.value;
    if (typeof fn === 'function') result.push({ name, key: name, fn: fn as ApiFunction, receiver: source });
  }
  return result;
}

type GeneratorResult = Generator<unknown, unknown> | AsyncGenerator<unknown, unknown>;
function isGenerator(value: unknown): value is GeneratorResult {
  if (value === null || typeof value !== 'object') return false;
  return (
    'next' in value &&
    typeof value.next === 'function' &&
    'return' in value &&
    typeof value.return === 'function' &&
    (Symbol.iterator in value || Symbol.asyncIterator in value)
  );
}

/** Use the original receiver for module methods. A generator's return is distinct from its yielded items. */
export async function callFunction(entry: Entry, args: unknown[], context: ToolContext) {
  const value: unknown = await Reflect.apply(entry.fn, entry.receiver, args);
  if (!isGenerator(value)) return value;
  const items: unknown[] = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      context.signal.throwIfAborted();
      const step = await value.next();
      context.signal.throwIfAborted();
      bytes += utf8Length(DSON.stringify(step.value));
      if (bytes > 1024 * 1024 || (!step.done && items.length === 1024))
        throw new RangeError('Function generator exceeded its collection limit.');
      if (step.done) {
        completed = true;
        return { items, result: step.value };
      }
      items.push(step.value);
      await context.progress(items.length);
    }
  } finally {
    if (!completed) await value.return(undefined);
  }
}
