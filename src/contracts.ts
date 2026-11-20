/** VERIFIED: The same parameter order and wire schemas drive public discovery, native calls and RPC forwarding. */
import { decodeBytes, encodeBytes, defaultByteLimit } from './binary.js';
import type { InputSchema } from './index.js';

type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array';
/** Portable JSON Schema subset emitted by the static compiler. Byte fields use canonical padded base64. */
export interface WireSchema {
  /** JSON scalar or container type. A two-element tuple admits null as well. */
  type: SchemaType | readonly [SchemaType, 'null'];
  /** Base64 string on the wire, Uint8Array in the application. The codec checks the combined byte budget. */
  contentEncoding?: 'base64';
  /** Human-readable field description copied into tools/list. */
  description?: string;
  /** Accepted literal values. The codec compares without coercion. */
  enum?: readonly (string | number | boolean | null)[];
  /** Required for array schemas. Applied to every element. */
  items?: WireSchema;
  /** Declared object fields. The named codec accepts only listed keys. */
  properties?: Record<string, WireSchema>;
  /** Fields that must be present as own properties. */
  required?: readonly string[];
  /** Generated object schemas publish false so clients can discover the closed field set. */
  additionalProperties?: boolean;
}
/** Ordered parameter names and object schemas shared by discovery, the native facade and RPC bridging. */
export interface FunctionContract {
  /** Purpose shown in tool discovery. */
  description?: string;
  /** Field names in the native call order, including the final rest field if present. */
  parameters: readonly string[];
  /** Name of the final variadic parameter. Its wire value is an array. */
  rest?: string;
  /** Object schema whose properties match the parameter list exactly. */
  inputSchema: WireSchema;
  /** Object result envelope with a value property, or an empty object for void. */
  outputSchema: WireSchema;
}
export const namedKey = 'org.defuss.mcp/named-v1';
const bindingsKey = Symbol.for('org.defuss.mcp/function-contracts-v1');
const scope = globalThis as typeof globalThis & { [bindingsKey]?: WeakMap<object, FunctionContract> };

/** Generated sidecars bind by function identity, including frozen functions and mixed ESM/CJS consumers. */
export function bindContract<F extends Function>(fn: F, contract: FunctionContract): F {
  const bindings = (scope[bindingsKey] ??= new WeakMap());
  const previous = bindings.get(fn);
  if (previous && JSON.stringify(previous) !== JSON.stringify(contract))
    throw new TypeError('Conflicting contracts for function ' + fn.name);
  bindings.set(fn, structuredClone(contract));
  return fn;
}
export const contractOf = (fn: object) => scope[bindingsKey]?.get(fn);

export class ContractIssue extends Error {
  constructor(
    readonly path: string,
    readonly keyword: string,
    readonly instruction: string,
  ) {
    super((path || '(root)') + ': ' + instruction);
  }
}
type Convert = (value: unknown, path: string, budget: { bytes: number }) => unknown;
const pointer = (key: string) => '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Compile trusted schema structure once. Base64 conversion uses the same strict decoder as compact calls. */
function converter(schema: WireSchema, encode: boolean): Convert {
  if (Array.isArray(schema.type)) {
    if (schema.type.length !== 2 || schema.type[1] !== 'null')
      throw new TypeError('Invalid nullable contract');
    const convert = converter({ ...schema, type: schema.type[0] }, encode);
    return (v, path, budget) => (v === null ? null : convert(v, path, budget));
  }
  if (schema.contentEncoding === 'base64')
    return (v, path, budget) => {
      if (encode) {
        if (!(v instanceof Uint8Array)) throw new ContractIssue(path, 'type', 'Supply a Uint8Array');
        if (v.byteLength > budget.bytes)
          throw new ContractIssue(path, 'maxLength', 'Reduce the total decoded byte size');
        budget.bytes -= v.byteLength;
        return encodeBytes(v).bytes;
      }
      try {
        const bytes = decodeBytes({ bytes: v }, budget.bytes);
        budget.bytes -= bytes.byteLength;
        return bytes;
      } catch (e) {
        if (e instanceof RangeError)
          throw new ContractIssue(path, 'maxLength', 'Reduce the total decoded byte size');
        throw new ContractIssue(path, 'contentEncoding', 'Send canonical padded base64');
      }
    };
  if (schema.type === 'array') {
    if (!schema.items) throw new TypeError('Contract array requires an item schema');
    const item = converter(schema.items, encode);
    return (v, path, budget) => {
      if (!Array.isArray(v)) throw new ContractIssue(path, 'type', 'Supply an array');
      return Array.from(v, (x, i) => item(x, path + '/' + i, budget));
    };
  }
  if (schema.type === 'object') {
    const entries = Object.entries(schema.properties ?? {}).map(([key, s]) => ({
      key,
      suffix: pointer(key),
      required: schema.required?.includes(key),
      convert: converter(s, encode),
    }));
    const keys = new Set(entries.map((e) => e.key));
    return (v, path, budget) => {
      if (!isObject(v)) throw new ContractIssue(path, 'type', 'Supply an object');
      for (const key of Object.keys(v))
        if (!keys.has(key))
          throw new ContractIssue(
            path + pointer(key),
            'additionalProperties',
            'Remove this unexpected field',
          );
      const result: Record<string, unknown> = {};
      for (const { key, suffix, required, convert } of entries) {
        if (Object.hasOwn(v, key) && !(encode && v[key] === undefined && !required)) {
          const value = convert(v[key], path + suffix, budget);
          if (key === '__proto__')
            Object.defineProperty(result, key, {
              value,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          else result[key] = value;
        } else if (required) throw new ContractIssue(path + suffix, 'required', 'Add this required field');
      }
      return result;
    };
  }
  return (v, path) => {
    const valid =
      schema.type === 'null'
        ? v === null
        : schema.type === 'integer'
          ? Number.isSafeInteger(v)
          : typeof v === schema.type && (schema.type !== 'number' || Number.isFinite(v));
    if (!valid) throw new ContractIssue(path, 'type', 'Supply type ' + schema.type);
    if (schema.enum && !schema.enum.some((x) => x === v))
      throw new ContractIssue(path, 'enum', 'Use one of ' + JSON.stringify(schema.enum));
    return v;
  };
}

/** Compile only the direction used by this endpoint. Positional holes retain JS default parameter semantics. */
export function makeContractCodec(contract: FunctionContract, side: 'client' | 'server') {
  const { parameters, rest, inputSchema, outputSchema } = contract;
  const props = inputSchema.properties ?? {};
  if (
    inputSchema.type !== 'object' ||
    outputSchema.type !== 'object' ||
    parameters.length !== Object.keys(props).length ||
    new Set(parameters).size !== parameters.length ||
    parameters.some((p) => !Object.hasOwn(props, p)) ||
    (rest !== undefined && (parameters.at(-1) !== rest || props[rest]?.type !== 'array'))
  )
    throw new TypeError('Invalid named function contract');
  const input = converter(inputSchema, side === 'client'),
    output = converter(outputSchema, side === 'server');
  const budget = () => ({ bytes: defaultByteLimit });
  function asNamed(args: readonly unknown[]) {
    if (!rest && args.length > parameters.length)
      throw new ContractIssue('', 'maxItems', 'Remove the extra positional arguments');
    const named: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < parameters.length; i++) {
      const key = parameters[i]!;
      if (key === rest) named[key] = args.slice(i);
      else if (i < args.length && args[i] !== undefined) named[key] = args[i];
    }
    return named;
  }
  return {
    encodeArgs(args: unknown[]) {
      return input(asNamed(args), '', budget()) as Record<string, unknown>;
    },
    decodeArgs(named: Record<string, unknown>) {
      const fields = input(named, '', budget()) as Record<string, unknown>;
      const args: unknown[] = [];
      for (let i = 0; i < parameters.length; i++) {
        const key = parameters[i]!;
        if (key === rest) {
          for (const x of (fields[key] as unknown[] | undefined) ?? []) args.push(x);
        } else if (Object.hasOwn(fields, key)) args[i] = fields[key];
        // Missing fixed slots before a nonempty rest array must retain their positions.
        else if (rest && Array.isArray(fields[rest]) && fields[rest].length) args.length = i + 1;
      }
      return args;
    },
    encodeResult(value: unknown) {
      const wrapped = value === undefined ? {} : { value };
      return output(wrapped, '', budget()) as Record<string, unknown>;
    },
    decodeResult(value: unknown) {
      return (output(value, '', budget()) as Record<string, unknown>).value;
    },
  };
}
export const asInputSchema = (schema: WireSchema) => schema as InputSchema;
